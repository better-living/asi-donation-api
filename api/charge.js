// api/charge.js

import { APIContracts, APIControllers } from 'authorizenet';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, message: 'Method not allowed' });
    return;
  }

  try {
    const { token, amount } = await req.json();

    if (!token || !amount) {
      res.status(400).json({ success: false, message: 'Missing token or amount' });
      return;
    }

    // Validate environment variables
    const apiLoginId = process.env.AUTHNET_API_LOGIN_ID;
    const transactionKey = process.env.AUTHNET_TRANSACTION_KEY;
    if (!apiLoginId || !transactionKey) {
      console.error('Missing Auth.Net credentials in env:', { apiLoginId, transactionKey });
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

    // Wrap callback-style execute in a promise
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

    const resultCode = result.getMessages()?.getResultCode();
    const transactionResponse = result.getTransactionResponse();

    if (resultCode === APIContracts.MessageTypeEnum.OK && transactionResponse?.getMessages()) {
      res.status(200).json({
        success: true,
        transactionId: transactionResponse.getTransId()
      });
    } else {
      // Try to extract an error message
      let errorMessage = 'Unknown error';
      if (transactionResponse?.getErrors && transactionResponse.getErrors()[0]) {
        errorMessage = transactionResponse.getErrors()[0].getErrorText();
      } else if (result.getMessages()?.getMessage && result.getMessages().getMessage()[0]) {
        errorMessage = result.getMessages().getMessage()[0].getText();
      }
      console.error('Authorize.Net error', { resultCode, errorMessage, transactionResponse });
      res.status(400).json({ success: false, message: errorMessage });
    }
  } catch (err) {
    console.error('Unhandled exception in /api/charge', err);
    res.status(500).json({ success: false, message: 'Internal server error', detail: err.message });
  }
}
