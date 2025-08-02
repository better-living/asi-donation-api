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
    designation,
    gift_amount,
    todays_gift,
    monthly_amount,
  } = body ?? {};

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

  // Build billTo with only first name, last name, phone
  const billTo = {};
  if (donor.first_name) billTo.firstName = donor.first_name;
  if (donor.last_name) billTo.lastName = donor.last_name;
  if (donor.cell_phone) billTo.phoneNumber = donor.cell_phone;

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
      },
    },
  };

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

    if (
      json &&
      json.messages?.resultCode === 'Ok' &&
      json.transactionResponse?.responseCode === '1'
    ) {
      const transactionId = json.transactionResponse.transId;

      // Prepare data to send to n8n webhook
      const webhookPayload = {
        transactionId,
        amount: formattedAmount,
        donor: {
          first_name: donor.first_name || null,
          last_name: donor.last_name || null,
          cell_phone: donor.cell_phone || null,
          email: donor.email || null,
          address: donor.address || null,
        },
        designation: designation || null,
        gift_amount: gift_amount ?? null,
        todays_gift: todays_gift ?? null,
        monthly_amount: monthly_amount ?? null,
        gateway: json,
        timestamp: new Date().toISOString(),
      };

      // Fire-and-forget to n8n but capture failure
      let webhookResult = { success: true };
      try {
        const hookResp = await fetch('https://n8n.heavenlyhost.org/webhook/9188d854-9d4e-4b93-b960-02e383afd212', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(webhookPayload),
          // you can set a short timeout if desired by using AbortController in a refined version
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

      const respBody = {
        success: true,
        transactionId,
        webhook: webhookResult,
      };

      return res.status(200).json(respBody);
    } else {
      // Extract error message
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
