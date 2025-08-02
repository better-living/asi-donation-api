// api/charge.js
export default async function handler(req, res) {
  // --- CORS setup (restrict to your frontend origin) ---
  const allowedOrigins = ['https://asiministries.org']; // add other allowed origins if needed
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // --- Parse body safely ---
  let body = req.body;
  try {
    if (typeof body === 'string') {
      body = JSON.parse(body);
    }
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

  // --- Credentials from environment ---
  const apiLoginID = process.env.AUTH_NET_API_LOGIN_ID;
  const transactionKey = process.env.AUTH_NET_TRANSACTION_KEY;

  if (!apiLoginID || !transactionKey) {
    return res
      .status(500)
      .json({ success: false, error: 'Server misconfigured: missing credentials' });
  }

  // Build billTo/customer if available
  const billTo = {};
  if (donor.first_name) billTo.firstName = donor.first_name;
  if (donor.last_name) billTo.lastName = donor.last_name;
  if (donor.address) {
    const addr = donor.address;
    if (addr.line) billTo.address = addr.line;
    if (addr.city) billTo.city = addr.city;
    if (addr.state) billTo.state = addr.state;
    if (addr.zip) billTo.zip = addr.zip;
    if (addr.country) billTo.country = addr.country;
  }
  if (donor.cell_phone) billTo.phoneNumber = donor.cell_phone;
  if (donor.email) billTo.email = donor.email;

  const customer = {};
  if (donor.email) customer.email = donor.email;
  // Optionally you could set customer.id if you have a CRM identifier

  // Order info: use designation and gift for invoice/description
  const order = {};
  if (designation) order.invoiceNumber = String(designation);
  const descParts = [];
  if (gift_amount) descParts.push(`Gift: ${gift_amount}`);
  if (monthly_amount) descParts.push(`Monthly: ${monthly_amount}`);
  if (todays_gift) descParts.push(`Today: ${todays_gift}`);
  if (descParts.length) order.description = descParts.join(' | ');

  // --- Build request payload ---
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
        // attach optional structured data if present
        ...(Object.keys(billTo).length ? { billTo } : {}),
        ...(Object.keys(customer).length ? { customer } : {}),
        ...(Object.keys(order).length ? { order } : {}),
      },
    },
  };

  // --- Send to Authorize.Net ---
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
