// Seed a test mailbox with realistic messages (local dev with GreenMail).
import nodemailer from 'nodemailer';
const to = process.argv[2] || 'owner@free.test';
const t = nodemailer.createTransport({ host: '127.0.0.1', port: 3025, secure: false, tls: { rejectUnauthorized: false } });
const mails = [
  ['Sarah Chen <sarah@northwind.test>', 'Q4 planning — agenda for Thursday', '<p>Hi Pete,</p><p>Here is the agenda for Thursday. Let me know if anything is missing:</p><ul><li>Budget review</li><li>Hiring plan</li><li>Launch timeline</li></ul><p>Thanks,<br>Sarah</p>'],
  ['GitHub <noreply@github.test>', '[mail-client] Pull request #42 merged', '<p>Your pull request <b>Add conversation view</b> was merged into main.</p>'],
  ['Marcus Lee <marcus@contoso.test>', 'Invoice #1043 for October', '<p>Hello, please find the October invoice attached. Payment due in 30 days.</p>'],
  ['AWS Billing <billing@aws.test>', 'Your AWS invoice is available', '<div style="font-family:Arial"><h2 style="color:#ff9900">AWS</h2><p>Your invoice for October 2026 is now available. Total: <b>$42.17</b></p><img src="https://example.com/track.gif" width=1 height=1></div>'],
  ['Priya Patel <priya@fabrikam.test>', 'Lunch next week?', '<p>Are you free for lunch Tuesday or Wednesday? There is a new ramen place downtown.</p>'],
  ['Newsletter <news@techweekly.test>', 'This week in tech: 10 stories you missed', '<h1>Tech Weekly</h1><p>AI, chips and the cloud...</p>'],
  ['Tom Rivera <tom@adatum.test>', 'Contract draft v3', '<p>Pete — attached is v3 of the contract with the edits from legal. Can you sign by Friday?</p>'],
];
for (const [from, subject, html] of mails) {
  await t.sendMail({ from, to, subject, html, headers: subject.startsWith('This week') ? { 'List-Unsubscribe': '<https://techweekly.test/unsub>' } : {},
    attachments: subject.includes('Invoice') || subject.includes('Contract') ? [{ filename: subject.includes('Invoice') ? 'invoice-1043.pdf' : 'contract-v3.docx', content: Buffer.from('demo') }] : [] });
}
console.log(`seeded ${mails.length} messages to ${to}`);
