// api/donate.js
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

  // Parse body
  let body = req.body;
  try {
    if (typeof body === 'string') body = JSON.parse(body);
  } catch (e) {
    return res.status(400).json({ success: false, error: 'Invalid JSON payload' });
  }

  const {
    opaqueData,
    amount,
    donor = {},
    gift_amount,
    todays_gift,
    monthly_amount,
    payment_method,
    echeck,
  } = body ?? {};

  const ECHECK_WEBHOOK = 'https://n8n.heavenlyhost.org/webhook/9188d854-9d4e-4b93-b960-02e383afd212';

  // eCheck path
  if (payment_method === 'echeck') {
    const webhookPayload = {
      payment_method: 'echeck',
      amount,
      donor,
      gift_amount: gift_amount ?? null,
      todays_gift: todays_gift ?? null,
      monthly_amount: monthly_amount ?? null,
      echeck: echeck ?? null,
      raw: body,
      timestamp: new Date().toISOString(),
    };

    try {
      const hookResp = await fetch(ECHECK_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(webhookPayload),
      });
      if (!hookResp.ok) {
        const t = await hookResp.text().catch(() => '');
        return res.status(500).json({
          success: false,
          error: 'Failed to deliver eCheck webhook',
          webhook: { status: hookResp.status, body: t },
        });
      }
      return res.status(200).json({ success: true, message: 'eCheck forwarded to webhook' });
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: 'Network error forwarding eCheck webhook: ' + err.message,
      });
    }
  }

  // Credit card path validation
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
    return res.status(500).json({
      success: false,
      error: 'Server misconfigured: missing credentials',
    });
  }

  // Build billTo explicitly, ensuring address is a string
  const billTo = {};
  if (donor.first_name) billTo.firstName = String(donor.first_name);
  if (donor.last_name) billTo.lastName = String(donor.last_name);
  if (donor.cell_phone) billTo.phoneNumber = String(donor.cell_phone);
  if (donor.email) billTo.email = String(donor.email);

  if (donor.address) {
    if (typeof donor.address === 'string') {
      billTo.address = donor.address;
    } else if (typeof donor.address === 'object' && donor.address !== null) {
      if (donor.address.line) billTo.address = String(donor.address.line);
      if (donor.address.city) billTo.city = String(donor.address.city);
      if (donor.address.state) billTo.state = String(donor.address.state);
      if (donor.address.zip) billTo.zip = String(donor.address.zip);
      if (donor.address.country) {
        const c = String(donor.address.country).trim();
        billTo.country = (c === 'United States' || c === 'US') ? 'USA' : c;
      }
    }
  }

  // Build userFields array
  const userFieldsArray = [];
  if (donor.organization) userFieldsArray.push({ name: 'organization', value: String(donor.organization) });
  if (gift_amount != null) userFieldsArray.push({ name: 'gift_amount', value: String(gift_amount) });
  if (todays_gift != null) userFieldsArray.push({ name: 'todays_gift', value: String(todays_gift) });
  if (monthly_amount != null) userFieldsArray.push({ name: 'monthly_amount', value: String(monthly_amount) });

  // Construct transactionRequest explicitly
  const transactionRequest = {
    transactionType: 'authCaptureTransaction',
    amount: formattedAmount,
    payment: {
      opaqueData: {
        dataDescriptor: opaqueData.dataDescriptor,
        dataValue: opaqueData.dataValue,
      },
    },
  };

  if (Object.keys(billTo).length) {
    transactionRequest.billTo = billTo;
  }
  if (userFieldsArray.length) {
    transactionRequest.userFields = { userField: userFieldsArray };
  }

  const requestBody = {
    createTransactionRequest: {
      merchantAuthentication: {
        name: apiLoginID,
        transactionKey: transactionKey,
      },
      transactionRequest,
    },
  };

  let gatewayResponse = null;

  try {
    const response = await fetch('https://api.authorize.net/xml/v1/request.api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    const status = response.status;
    const json = await response.json().catch(() => null);
    gatewayResponse = json;

    const successful =
      json &&
      json.messages?.resultCode === 'Ok' &&
      json.transactionResponse?.responseCode === '1';

    if (successful) {
      const transactionId = json.transactionResponse.transId;

      // Prepare webhook payload
      const webhookPayload = {
        payment_method: 'credit_card',
        transactionId,
        amount: formattedAmount,
        donor: {
          first_name: donor.first_name || null,
          last_name: donor.last_name || null,
          cell_phone: donor.cell_phone || null,
          email: donor.email || null,
          organization: donor.organization || null,
          address: donor.address || null,
        },
        gift_amount: gift_amount ?? null,
        todays_gift: todays_gift ?? null,
        monthly_amount: monthly_amount ?? null,
        gateway: json,
        timestamp: new Date().toISOString(),
      };

      // Fire-and-forget webhook
      let webhookResult = { success: true };
      try {
        const hookResp = await fetch(ECHECK_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(webhookPayload),
        });
        if (!hookResp.ok) {
          const text = await hookResp.text().catch(() => '');
          webhookResult = { success: false, status: hookResp.status, body: text };
        }
      } catch (err) {
        webhookResult = { success: false, error: err.message };
      }

      return res.status(200).json({
        success: true,
        transactionId,
        webhook: webhookResult,
      });
    } else {
      // Log structured payload (sanitized) for debugging
      console.error('Authorize.Net request failed. Sent payload:', JSON.stringify({
        createTransactionRequest: {
          merchantAuthentication: { name: apiLoginID, transactionKey: 'REDACTED' },
          transactionRequest: {
            ...transactionRequest,
            payment: { opaqueData: { dataDescriptor: 'REDACTED', dataValue: 'REDACTED' } },
          },
        },
      }, null, 2));

      // Extract error details
      let errMsg = 'Unknown error from gateway';
      if (
        json?.transactionResponse?.errors &&
        Array.isArray(json.transactionResponse.errors) &&
        json.transactionResponse.errors.length
      ) {
        errMsg = json.transactionResponse.errors.map(e => e.errorText).join('; ');
      } else if (
        json?.messages?.message &&
        Array.isArray(json.messages.message) &&
        json.messages.message.length
      ) {
        errMsg = json.messages.message.map(m => m.text).join('; ');
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
      raw: gatewayResponse,
    });
  }
}
