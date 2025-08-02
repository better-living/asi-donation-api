// api/charge.js
function escapeXml(unsafe) {
  if (unsafe == null) return '';
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

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

  // Build billTo XML parts (name, email, phone, address)
  const billToParts = [];
  if (donor.first_name) billToParts.push(`<firstName>${escapeXml(donor.first_name)}</firstName>`);
  if (donor.last_name) billToParts.push(`<lastName>${escapeXml(donor.last_name)}</lastName>`);
  if (donor.address && donor.address.line) billToParts.push(`<address>${escapeXml(donor.address.line)}</address>`);
  if (donor.address && donor.address.city) billToParts.push(`<city>${escapeXml(donor.address.city)}</city>`);
  if (donor.address && donor.address.state) billToParts.push(`<state>${escapeXml(donor.address.state)}</state>`);
  if (donor.address && donor.address.zip) billToParts.push(`<zip>${escapeXml(donor.address.zip)}</zip>`);
  if (donor.address && donor.address.country) billToParts.push(`<country>${escapeXml(donor.address.country)}</country>`);
  if (donor.email) billToParts.push(`<email>${escapeXml(donor.email)}</email>`);
  if (donor.cell_phone) billToParts.push(`<phoneNumber>${escapeXml(donor.cell_phone)}</phoneNumber>`);

  const billToXml = billToParts.length ? `<billTo>${billToParts.join('')}</billTo>` : '';

  // Build userFields: designation + description + breakdown
  const userFieldEntries = [];

  if (designation) {
    userFieldEntries.push(
      `<userField><name>designation</name><value>${escapeXml(String(designation))}</value></userField>`
    );
  }

  // Human-friendly description combining key pieces
  const descParts = [];
  if (gift_amount !== undefined) descParts.push(`Gift: ${gift_amount}`);
  if (todays_gift !== undefined) descParts.push(`Today: ${todays_gift}`);
  if (monthly_amount !== undefined) descParts.push(`Monthly: ${monthly_amount}`);
  if (descParts.length) {
    userFieldEntries.push(
      `<userField><name>description</name><value>${escapeXml(descParts.join(' | '))}</value></userField>`
    );
  }

  // Optional granular fields
  if (gift_amount !== undefined) {
    userFieldEntries.push(
      `<userField><name>gift_amount</name><value>${escapeXml(String(gift_amount))}</value></userField>`
    );
  }
  if (todays_gift !== undefined) {
    userFieldEntries.push(
      `<userField><name>todays_gift</name><value>${escapeXml(String(todays_gift))}</value></userField>`
    );
  }
  if (monthly_amount !== undefined) {
    userFieldEntries.push(
      `<userField><name>monthly_amount</name><value>${escapeXml(String(monthly_amount))}</value></userField>`
    );
  }

  const userFieldsXml = userFieldEntries.length
    ? `<userFields>${userFieldEntries.join('')}</userFields>`
    : '';

  // Full XML payload
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<createTransactionRequest xmlns="AnetApi/xml/v1/schema/AnetApiSchema.xsd">
  <merchantAuthentication>
    <name>${escapeXml(apiLoginID)}</name>
    <transactionKey>${escapeXml(transactionKey)}</transactionKey>
  </merchantAuthentication>
  <transactionRequest>
    <transactionType>authCaptureTransaction</transactionType>
    <amount>${escapeXml(formattedAmount)}</amount>
    <payment>
      <opaqueData>
        <dataDescriptor>${escapeXml(opaqueData.dataDescriptor)}</dataDescriptor>
        <dataValue>${escapeXml(opaqueData.dataValue)}</dataValue>
      </opaqueData>
    </payment>
    ${billToXml}
    ${userFieldsXml}
  </transactionRequest>
</createTransactionRequest>`;

  try {
    const response = await fetch('https://api.authorize.net/xml/v1/request.api', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/xml',
      },
      body: xml,
    });

    const text = await response.text();
    let parsedJson = null;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      // response may be XML; fall back to raw
    }

    if (
      parsedJson &&
      parsedJson.messages?.resultCode === 'Ok' &&
      parsedJson.transactionResponse?.responseCode === '1'
    ) {
      return res.status(200).json({
        success: true,
        transactionId: parsedJson.transactionResponse.transId,
      });
    }

    // If JSON parsing failed or gateway error, return raw for debugging
    return res.status(400).json({
      success: false,
      error: 'Gateway failure or unexpected response',
      raw: parsedJson ?? text,
      httpStatus: response.status,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Request to payment gateway failed: ' + err.message,
    });
  }
}
