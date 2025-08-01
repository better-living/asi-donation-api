// api/charge.js

import { APIContracts, APIControllers } from 'authorizenet';

export async function POST(req) {
  const { token, amount } = await req.json();

  const merchantAuthenticationType = new APIContracts.MerchantAuthenticationType();
  merchantAuthenticationType.setName(process.env.AUTHNET_API_LOGIN_ID);
  merchantAuthenticationType.setTransactionKey(process.env.AUTHNET_TRANSACTION_KEY);

  const opaqueData = new APIContracts.OpaqueDataType();
  opaqueData.setDataDescriptor("COMMON.ACCEPT.INAPP.PAYMENT");
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

  return new Promise((resolve) => {
    ctrl.execute(() => {
      const apiResponse = ctrl.getResponse();
      const response = new APIContracts.CreateTransactionResponse(apiResponse);

      if (!response) {
        return resolve(new Response(JSON.stringify({ success: false, message: "Null response from gateway" }), {
          headers: { 'Content-Type': 'application/json' }
        }));
      }

      const resultCode = response.getMessages().getResultCode();
      const transactionResponse = response.getTransactionResponse();

      if (resultCode === APIContracts.MessageTypeEnum.OK && transactionResponse?.getMessages()) {
        return resolve(new Response(JSON.stringify({
          success: true,
          transactionId: transactionResponse.getTransId()
        }), { headers: { 'Content-Type': 'application/json' } }));
      } else {
        const errorMessage = transactionResponse?.getErrors?.()[0]?.getErrorText?.()
          || response.getMessages().getMessage()[0].getText();
        return resolve(new Response(JSON.stringify({
          success: false,
          message: errorMessage
        }), { headers: { 'Content-Type': 'application/json' } }));
      }
    });
  });
}
