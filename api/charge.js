// api/charge.js
export default async function handler(req, res) {
  const allowedOrigins = ['https://asiministries.org'];
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  let body = req.body;
  try {
    if (typeof body === 'string') body = JSON.parse(body);
  } catch (e) {
    return res.status(400).json({ success: false, error: 'Invalid JSON payload' });
  }

  const { opaqueData, amount, donor = {}, designation, gift_amount, todays_gift, monthly_amount } = body ?? {};

  if (!opaqueData || !amount) {
    return res.status(400).json({ success: false, error: 'Missing opaqueData or amount' });
  }

  const amountNum = parseFloat(amount);
  if (isNaN(amountNum) || amountNum <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid amount' });
  }
  const formattedAmount = amountNum.toFixed(2);

  if (
    typeof opaqueData !== 'object' ||
    !opaqueData.dataDescriptor ||
    !opaqueData.dataValue
  ) {
    return res.status(400).json({ success: false, error: 'Malformed opaqueData' });
  }

  const apiLoginID = process.env.AUTH_NET_API_LOGIN_ID;
  const transactionKey = process.env.AUTH_NET_TRANSACTION_KEY;

  if (!apiLoginID || !transactionKey) {
    return res.status(500).json({ success: false, error: 'Server misconfigured: missing credentials' });
  }

  // Build billTo: name + phone (email goes to userFields)
  const billTo = {};
  if (donor.first_name) billTo.firstName = donor.first_name;
  if (donor.last_name) billTo.lastName = donor.last_name;
  if (donor.cell_phone) billTo.phoneNumber = donor.cell_phone;

  // Build userFields array: include email and optionally other metadata
  const userFields = [];
  if (donor.email) {
    userFields.push({ name: 'email', value: donor.email });
  }
  if (designation) {
    userFields.push({ name: 'designation', value: String(designation) });
  }
  if (gift_amount !== undefined) {
    userFields.push({ name: 'gift_amount', value: String(gift_amount) });
  }
  if (todays_gift !== undefined) {
    userFields.push({ name: 'todays_gift', value: String(todays_gift) });
  }
  if (monthly_amount !== undefined) {
    userFields.push({ name: 'monthly_amount', value: String(monthly_amount) });
  }

  const endpoint = 'https://api.authorize.net/xml/v1/request.api';
  const payload = {
    createTransactionRequest: {
      merchantAuthentication: {
        name: apiLoginID,
        transactionKey: transactionKey,
      },
      transactionRequest: {
        transactionType: 'authCaptureTransaction',
        amount: formattedAmount,
        payment: {
          opaqueData: {
            dataDescriptor: opaqueData.dataDescriptor,
            dataValue: opaqueData.dataValue,
          },
        },
        ...(Object.keys(billTo).length ? { billTo } : {}),
        ...(userFields.length
          ? {
              userFields: {
                userField: userFields,
              },
            }
          : {}),
      },
    },
  };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const status = response.status;
    const json = await response.json().catch(() => null);

    if (
      json &&
      json.messages?.resultCode === 'Ok' &&
      json.transactionResponse?.responseCode === '1'
    ) {
      return res.status(200).json({
        success: true,
        transactionId: json.transactionResponse.transId,
      });
    } else {
      let errMsg = 'Unknown error from gateway';
      if (
        json?.transactionResponse?.errors &&
        Array.isArray(json.transactionResponse.errors) &&
        json.transactionResponse.errors.length
      ) {
        errMsg = json.transactionResponse.errors.map((e) => e.errorText).join('; ');
      } else if (
        json?.messages?.message &&
        Array.isArray(json.messages.message) &&
        json.messages.message.length
      ) {
        errMsg = json.messages.message.map((m) => m.text).join('; ');
      } else if (json && json.transactionResponse?.responseCode) {
        errMsg = `Gateway responseCode=${json.transactionResponse.responseCode}`;
      }

      return res.status(400).json({
        success: false,
        error: errMsg,
        raw: json,
        httpStatus: status,
      });
    }
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Request to payment gateway failed: ' + err.message,
    });
  }
}
