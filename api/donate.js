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

  // Body parsing
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
  } = body ?? {};

  // If user intends eCheck (front-end already posts to webhook, but support fallback)
  const ECHECK_WEBHOOK = 'https://n8n.heavenlyhost.org/webhook/9188d854-9d4e-4b93-b960-02e383afd212';

  if (payment_method === 'echeck') {
    // Simply forward everything to webhook; no Authorize.Net call.
    const webhookPayload = {
      payment_method: 'echeck',
      amount,
      donor,
      gift_amount: gift_amount ?? null,
      todays_gift: todays_gift ?? null,
      monthly_amount: monthly_amount ?? null,
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

  // Credit card path: require opaqueData and amount
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
    return res
      .status(500)
      .json({ success: false, error: 'Server misconfigured: missing credentials' });
  }

  // Build billTo with basic name/phone (avoid invalid nested objects)
  const billTo = {};
  if (donor.first_name) billTo.firstName = donor.first_name;
  if (donor.last_name) billTo.lastName = donor.last_name;
  if (donor.cell_phone) billTo.phoneNumber = donor.cell_phone;

  // Compose userFields to include extra metadata (email, address, organization, gift info)
  const userFields = [];
  if (donor.email) userFields.push({ name: 'email', value: donor.email });
  if (donor.organization) userFields.push({ name: 'organization', value: donor.organization });
  if (donor.address) {
    if (donor.address.line) userFields.push({ name: 'address_line', value: donor.address.line });
    if (donor.address.city) userFields.push({ name: 'address_city', value: donor.address.city });
    if (donor.address.state) userFields.push({ name: 'address_state', value: donor.address.state });
    if (donor.address.zip) userFields.push({ name: 'address_zip', value: donor.address.zip });
    if (donor.address.country) userFields.push({ name: 'address_country', value: donor.address.country });
  }
  if (gift_amount != null) userFields.push({ name: 'gift_amount', value: String(gift_amount) });
  if (todays_gift != null) userFields.push({ name: 'todays_gift', value: String(todays_gift) });
  if (monthly_amount != null) userFields.push({ name: 'monthly_amount', value: String(monthly_amount) });

  // Build Authorize.Net request payload
  const endpoint = 'https://api.authorize.net/xml/v1/request.api';
  const createTransactionRequest = {
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
      ...(userFields.length ? { userFields: { userField: userFields } } : {}),
    },
  };

  const payload = { createTransactionRequest };

  let gatewayResponse = null;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const status = response.status;
    const json = await response.json().catch(() => null);
    gatewayResponse = json;

    const successCondition =
      json &&
      json.messages?.resultCode === 'Ok' &&
      json.transactionResponse?.responseCode === '1';

    if (successCondition) {
      const transactionId = json.transactionResponse.transId;

      // Webhook payload to n8n
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

      // Send to webhook
      let webhookResult = { success: true };
      try {
        const hookResp = await fetch(ECHECK_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(webhookPayload),
        });
        if (!hookResp.ok) {
          const text = await hookResp.text().catch(() => '');
          webhookResult = {
            success: false,
            status: hookResp.status,
            body: text,
          };
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
      // Extract error message with priority
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
      raw: gatewayResponse,
    });
  }
}
