// api/charge.js

import pkg from 'authorizenet';
const { APIContracts, APIControllers } = pkg;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, message: 'Method not allowed' });
    return;
  }

  try {
    const { token, amount } = req.body ?? {};

    if (!token || !amount) {
      res.status(400).json({ success: false, message: 'Missing token or amount' });
      return;
    }

    const apiLoginId = process.env.AUTHNET_API_LOGIN_ID;
    const transactionKey = process.env.AUTHNET_TRANSACTION_KEY;
    if (!apiLoginId || !transactionKey) {
      console.error('Missing Authorize.Net credentials', { apiLoginId, transactionKey });
      res.status(500).json({ success: false, message: 'Payment gateway not configured' });
      return;
    }

    const merchantAuthenticationType = new APIContracts.MerchantAuthenticationType();
    merchantAuthenticationType.setName(apiLoginId);
    merchantAuthenticationType.setTransactionKey(transactionKey);

    const opaqueData = new APIContracts.OpaqueDataType();
    opaqueData.setDataDescriptor('COMMON.ACCEPT.INAPP.PAYMENT');
    opaqueData.setDataValue(token);

    const paymentType = new APIContracts.PaymentType();
    paymentType.setOpaqueData(opaqueData);

    const transactionRequestType = new APIContracts.TransactionRequestType();
    transactionRequestType.setTransactionType(APIContracts.TransactionTypeEnum.AUTHCAPTURETRANSACTION);
    transactionRequestType.setPayment(paymentType);
    transactionRequestType.setAmount(parseFloat(amount));

    const createRequest = new APIContracts.CreateTransactionRequest();
    createRequest.setMerchantAuthentication(merchantAuthenticationType);
    createRequest.setTransactionRequest(transactionRequestType);

    const ctrl = new APIControllers.CreateTransactionController(createRequest.getJSON());

    const result = await new Promise((resolve) => {
      ctrl.execute(() => {
        const apiResponse = ctrl.getResponse();
        const response = new APIContracts.CreateTransactionResponse(apiResponse);
        resolve(response);
      });
    });

    if (!result) {
      res.status(502).json({ success: false, message: 'Null response from gateway' });
      return;
    }

    // Debug log the raw structure (can remove later)
    console.debug('Authorize.Net raw response:', {
      messages: result.getMessages?.()?.getMessage ? result.getMessages().getMessage().map(m => ({
        code: m.getCode?.(),
        text: m.getText?.()
      })) : null,
      transactionResponse: (() => {
        try {
          const tr = result.getTransactionResponse?.();
          if (!tr) return null;
          return {
            transId: tr.getTransId?.(),
            responseCode: tr.getResponseCode?.(),
            errors: tr.getErrors?.() ? tr.getErrors().map(e => ({
              errorCode: e.getErrorCode?.(),
              errorText: e.getErrorText?.()
            })) : null,
            messages: tr.getMessages?.() ? tr.getMessages().map(m => ({
              code: m.getCode?.(),
              description: m.getDescription?.()
            })) : null
          };
        } catch (e) {
          return `error reading transactionResponse: ${e.message}`;
        }
      })()
    });

    const resultCode = result.getMessages && result.getMessages().getResultCode
      ? result.getMessages().getResultCode()
      : null;
    const transactionResponse = result.getTransactionResponse?.();

    if (
      resultCode === APIContracts.MessageTypeEnum.OK &&
      transactionResponse &&
      transactionResponse.getMessages &&
      typeof transactionResponse.getMessages === 'function' &&
      transactionResponse.getMessages()
    ) {
      res.status(200).json({
        success: true,
        transactionId: transactionResponse.getTransId()
      });
      return;
    }

    // Extract an error message defensively
    let errorMessage = 'Unknown error';
    if (
      transactionResponse &&
      transactionResponse.getErrors &&
      typeof transactionResponse.getErrors === 'function' &&
      transactionResponse.getErrors() &&
      transactionResponse.getErrors()[0] &&
      typeof transactionResponse.getErrors()[0].getErrorText === 'function'
    ) {
      errorMessage = transactionResponse.getErrors()[0].getErrorText();
    } else if (
      result &&
      result.getMessages &&
      typeof result.getMessages === 'function' &&
      result.getMessages().getMessage &&
      typeof result.getMessages().getMessage === 'function' &&
      result.getMessages().getMessage()[0] &&
      typeof result.getMessages().getMessage()[0].getText === 'function'
    ) {
      errorMessage = result.getMessages().getMessage()[0].getText();
    }

    console.error('Payment failed', { resultCode, errorMessage });
    res.status(400).json({ success: false, message: errorMessage });
  } catch (err) {
    console.error('Unhandled exception in /api/charge', err);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      detail: err.message
    });
  }
}
