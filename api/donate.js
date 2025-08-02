// api/donate.js
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const { opaqueData, amount } = req.body ?? {};

  if (!opaqueData || !amount) {
    return res.status(400).json({ success: false, error: 'Missing opaqueData or amount' });
  }

  const apiLoginID = process.env.AUTH_NET_API_LOGIN_ID;
  const transactionKey = process.env.AUTH_NET_TRANSACTION_KEY;

  if (!apiLoginID || !transactionKey) {
    return res.status(500).json({ success: false, error: 'Server misconfigured: missing credentials' });
  }

  const endpoint = 'https://api.authorize.net/xml/v1/request.api';

  const payload = {
    createTransactionRequest: {
      merchantAuthentication: {
        name: apiLoginID,
        transactionKey: transactionKey
      },
      transactionRequest: {
        transactionType: 'authCaptureTransaction',
        amount: amount,
        payment: {
          opaqueData: {
            dataDescriptor: opaqueData.dataDescriptor,
            dataValue: opaqueData.dataValue
          }
        }
      }
    }
  };

  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const json = await r.json().catch(() => null);

    if (json?.messages?.resultCode === 'Ok' && json?.transactionResponse?.responseCode === '1') {
      return res.status(200).json({
        success: true,
        transactionId: json.transactionResponse.transId
      });
    } else {
      // extract error
      let errMsg = 'Unknown error';
      if (json?.transactionResponse?.errors && json.transactionResponse.errors.length) {
        errMsg = json.transactionResponse.errors.map(e => e.errorText).join('; ');
      } else if (json?.messages?.message && json.messages.message.length) {
        errMsg = json.messages.message.map(m => m.text).join('; ');
      }
      return res.status(400).json({ success: false, error: errMsg, raw: json });
    }
  } catch (e) {
    return res.status(500).json({ success: false, error: 'Request failed: ' + e.message });
  }
}
