// api/charge.js

import pkg from 'authorizenet';
const { APIContracts, APIControllers } = pkg;

const sendJson = (res, status, payload) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.status(status).json(payload);
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    // Preflight
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { success: false, message: 'Method not allowed' });
  }

  try {
    const { token, amount } = req.body ?? {};

    if (!token || !amount) {
      return sendJson(res, 400, { success: false, message: 'Missing token or amount' });
    }

    const apiLoginId = process.env.AUTHNET_API_LOGIN_ID;
    const transactionKey = process.env.AUTHNET_TRANSACTION_KEY;
    if (!apiLoginId || !transactionKey) {
      console.error('Missing Authorize.Net credentials', { apiLoginId, transactionKey });
      return sendJson(res, 500, { success: false, message: 'Payment gateway not configured' });
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
      return sendJson(res, 502, { success: false, message: 'Null response from gateway' });
    }

    const resultCode = result.getMessages?.()?.getResultCode?.();
    const transactionResponse = result.getTransactionResponse?.();

    if (
      resultCode === APIContracts.MessageTypeEnum.OK &&
      transactionResponse &&
      transactionResponse.getMessages &&
      typeof transactionResponse.getMessages === 'function' &&
      transactionResponse.getMessages()
    ) {
      return sendJson(res, 200, {
        success: true,
        transactionId: transactionResponse.getTransId()
      });
    }

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
    return sendJson(res, 400, { success: false, message: errorMessage });
  } catch (err) {
    console.error('Unhandled exception in /api/charge', err);
    return sendJson(res, 500, {
      success: false,
      message: 'Internal server error',
      detail: err.message
    });
  }
}
