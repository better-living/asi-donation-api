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

  // Build userFields XML entries
  const userFieldEntries = [];
  if (donor.email) {
    userFieldEntries.push(`<userField><name>email</name><value>${escapeXml(donor.email)}</value></userField>`);
  }
  if (designation) {
    userFieldEntries.push(`<userField><name>designation</name><value>${escapeXml(String(designation))}</value></userField>`);
  }
  if (gift_amount !== undefined) {
    userFieldEntries.push(`<userField><name>gift_amount</name><value>${escapeXml(String(gift_amount))}</value></userField>`);
  }
  if (todays_gift !== undefined) {
    userFieldEntries.push(`<userField><name>todays_gift</name><value>${escapeXml(String(todays_gift))}</value></userField>`);
  }
  if (monthly_amount !== undefined) {
    userFieldEntries.push(`<userField><name>monthly_amount</name><value>${escapeXml(String(monthly_amount))}</value></userField>`);
  }
  if (donor.address) {
    const addr = donor.address;
    if (addr.line) userFieldEntries.push(`<userField><name>address_line</name><value>${escapeXml(addr.line)}</value></userField>`);
    if (addr.city) userFieldEntries.push(`<userField><name>city</name><value>${escapeXml(addr.city)}</value></userField>`);
    if (addr.state) userFieldEntries.push(`<userField><name>state</name><value>${escapeXml(addr.state)}</value></userField>`);
    if (addr.zip) userFieldEntries.push(`<userField><name>zip</name><value>${escapeXml(addr.zip)}</value></userField>`);
    if (addr.country) userFieldEntries.push(`<userField><name>country</name><value>${escapeXml(addr.country)}</value></userField>`);
  }

  const billToParts = [];
  if (donor.first_name) billToParts.push(`<firstName>${escapeXml(donor.first_name)}</firstName>`);
  if (donor.last_name) billToParts.push(`<lastName>${escapeXml(donor.last_name)}</lastName>`);
  if (donor.address && donor.address.line) billToParts.push(`<address>${escapeXml(donor.address.line)}</address>`);
  if (donor.address && donor.address.city) billToParts.push(`<city>${escapeXml(donor.address.city)}</city>`);
  if (donor.address && donor.address.state) billToParts.push(`<state>${escapeXml(donor.address.state)}</state>`);
  if (donor.address && donor.address.zip) billToParts.push(`<zip>${escapeXml(donor.address.zip)}</zip>`);
  if (donor.address && donor.address.country) billToParts.push(`<country>${escapeXml(donor.address.country)}</country>`);
  if (donor.cell_phone) billToParts.push(`<phoneNumber>${escapeXml(donor.cell_phone)}</phoneNumber>`);
  if (donor.email) billToParts.push(`<email>${escapeXml(donor.email)}</email>`);

  const billToXml = billToParts.length ? `<billTo>${billToParts.join('')}</billTo>` : '';

  const userFieldsXml = userFieldEntries.length
    ? `<userFields>${userFieldEntries.join('')}</userFields>`
    : '';

  // Build full XML payload
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
    // Try to parse JSON fallback if they return JSON; otherwise return raw for debugging
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Possibly XML response; send back raw
    }

    // If JSON parsed, use same logic:
    if (
      parsed &&
      parsed.messages?.resultCode === 'Ok' &&
      parsed.transactionResponse?.responseCode === '1'
    ) {
      return res.status(200).json({
        success: true,
        transactionId: parsed.transactionResponse.transId,
      });
    }

    // If XML or error, attempt to extract some info for debugging
    // Fallback: return raw response
    return res.status(400).json({
      success: false,
      error: 'Gateway response indicated failure',
      raw: parsed ?? text,
      httpStatus: response.status,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Request to payment gateway failed: ' + err.message,
    });
  }
}
