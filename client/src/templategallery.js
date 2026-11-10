// Smart templates: ready-made emails people can use as they are or copy and change, and the fill-in fields
// ({{first_name}}, {{date}}, or anything you make up, like {{price}}) that are filled in when a template is used.
// Built-in fields fill themselves from the recipient and from you; anything else is asked for in a short form.

export const BUILTIN_FIELDS = [
  ['first_name', 'Their first name'],
  ['name', 'Their full name'],
  ['my_first_name', 'My first name'],
  ['my_name', 'My full name'],
  ['my_email', 'My email'],
  ['date', 'Today’s date'],
  ['day', 'Today (weekday)'],
];
const BUILTIN = new Set(BUILTIN_FIELDS.map(([k]) => k));

const FIELD_RE = /\{\{\s*([A-Za-z][\w ]{0,40}?)\s*\}\}/g;
export const fieldKey = (s) => String(s).trim().toLowerCase().replace(/\s+/g, '_');
export const fieldLabel = (k) => BUILTIN_FIELDS.find(([x]) => x === k)?.[1] || k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Every field used in a template, in order of first appearance. */
export function templateFields(t) {
  const seen = [];
  for (const src of [t.subject || '', t.html || '']) for (const m of src.matchAll(FIELD_RE)) { const k = fieldKey(m[1]); if (!seen.includes(k)) seen.push(k); }
  return seen;
}
/** Fields the person has to type in (not filled automatically). */
export const customFields = (t) => templateFields(t).filter((k) => !BUILTIN.has(k));

/** Values for the built-in fields: recipient (first To) and me. */
export function builtinValues({ to, me }) {
  const r = to?.[0] || {};
  const rName = (r.name || '').trim();
  const guess = (r.address || '').split('@')[0].split(/[._-]/)[0];
  const first = rName ? rName.split(/\s+/)[0] : guess ? guess[0].toUpperCase() + guess.slice(1) : '';
  const myName = (me?.name || '').trim();
  const now = new Date();
  return {
    first_name: first || 'there', name: rName || first || '',
    my_first_name: myName.split(/\s+/)[0] || '', my_name: myName, my_email: me?.email || '',
    date: now.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }),
    day: now.toLocaleDateString(undefined, { weekday: 'long' }),
  };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Fill a template. HTML gets escaped values; the subject plain text. Unknown fields are left as typed. */
export function fillTemplate(t, values) {
  const get = (raw, html) => { const k = fieldKey(raw); const v = values[k]; return v === undefined || v === '' ? `{{${raw}}}` : html ? esc(v) : String(v); };
  return {
    subject: (t.subject || '').replace(FIELD_RE, (_, k) => get(k, false)),
    html: (t.html || '').replace(FIELD_RE, (_, k) => get(k, true)),
  };
}

// ---------------------------------------------------------------- the gallery
const p = (...lines) => lines.map((l) => (l === '' ? '<div><br></div>' : `<div>${l}</div>`)).join('');
const T = (id, category, name, subject, html) => ({ id: `g-${id}`, category, name, subject, html, gallery: true });

export const GALLERY = [
  // Everyday
  T('thanks', 'Everyday', 'Thank you', 'Thank you', p('Hi {{first_name}},', '', 'Thank you so much for {{what_for}}. I really appreciate it.', '', 'Best,', '{{my_first_name}}')),
  T('got-it', 'Everyday', 'Got it, will reply soon', 'Re: your email', p('Hi {{first_name}},', '', 'Thanks for your email — I’ve got it. I’ll come back to you by {{when}}.', '', 'Best,', '{{my_first_name}}')),
  T('intro', 'Everyday', 'Introduce two people', 'Introduction: {{person_a}} ↔ {{person_b}}', p('Hi {{person_a}} and {{person_b}},', '', 'I’d like to introduce you two. {{person_a}} {{about_a}}. {{person_b}} {{about_b}}.', '', 'I think you’d have a lot to talk about. I’ll let you take it from here.', '', 'Best,', '{{my_first_name}}')),
  T('decline', 'Everyday', 'Politely say no', 'Re: {{topic}}', p('Hi {{first_name}},', '', 'Thank you for thinking of me for {{topic}}. Unfortunately I can’t take this on right now, but I hope it goes really well.', '', 'All the best,', '{{my_first_name}}')),
  T('sorry', 'Everyday', 'Sorry for the slow reply', 'Sorry for the slow reply', p('Hi {{first_name}},', '', 'Sorry it’s taken me a while to get back to you. {{answer}}', '', 'Thanks for your patience,', '{{my_first_name}}')),

  // Follow-up
  T('bump', 'Follow-up', 'Gentle follow-up', 'Following up: {{topic}}', p('Hi {{first_name}},', '', 'Just bringing this back to the top of your inbox — did you get a chance to look at {{topic}}?', '', 'Happy to answer any questions.', '', 'Thanks,', '{{my_first_name}}')),
  T('after-meeting', 'Follow-up', 'After a meeting', 'Great to meet today', p('Hi {{first_name}},', '', 'Thanks for your time today. As promised, here’s a quick recap:', '', '• {{point_1}}', '• {{point_2}}', '', 'Next step: {{next_step}}.', '', 'Best,', '{{my_first_name}}')),
  T('last-try', 'Follow-up', 'Last follow-up', 'Should I close this out?', p('Hi {{first_name}},', '', 'I haven’t heard back, so I’m guessing now isn’t the right time. I’ll close this out for now — just reply if anything changes and I’ll pick it straight back up.', '', 'Best,', '{{my_first_name}}')),

  // Scheduling
  T('meet', 'Scheduling', 'Ask to meet', 'Quick call?', p('Hi {{first_name}},', '', 'Would you have 20 minutes for a quick call about {{topic}}? Here are a few times that work for me:', '', '• {{time_1}}', '• {{time_2}}', '', 'Or pick any time that suits you here: {{booking_link}}', '', 'Thanks,', '{{my_first_name}}')),
  T('confirm', 'Scheduling', 'Confirm a meeting', 'Confirmed: {{day_and_time}}', p('Hi {{first_name}},', '', 'Just confirming we’re meeting on {{day_and_time}} at {{place}}. Looking forward to it.', '', 'Best,', '{{my_first_name}}')),
  T('resched', 'Scheduling', 'Reschedule', 'Can we move our meeting?', p('Hi {{first_name}},', '', 'I’m sorry, something has come up and I can’t make {{original_time}}. Would {{new_time}} work instead?', '', 'Apologies for the change,', '{{my_first_name}}')),

  // Sales
  T('quote', 'Sales', 'Send a quote', 'Your quote for {{service}}', p('Hi {{first_name}},', '', 'Thanks for asking. Here’s the quote for {{service}}:', '', '<b>Price:</b> {{price}}', '<b>Timing:</b> {{timing}}', '', 'This quote is good for 30 days. Just reply to go ahead, or if you have any questions.', '', 'Best,', '{{my_name}}')),
  T('cold', 'Sales', 'First outreach', '{{company}} + {{my_company}}', p('Hi {{first_name}},', '', 'I noticed {{reason}} and thought we might be able to help. We {{what_we_do}}.', '', 'Would you be open to a 15-minute call next week?', '', 'Best,', '{{my_name}}')),
  T('welcome-customer', 'Sales', 'Welcome a new customer', 'Welcome aboard, {{first_name}}!', p('Hi {{first_name}},', '', 'Welcome! We’re really glad to have you. Here’s what happens next:', '', '1. {{step_1}}', '2. {{step_2}}', '', 'If you need anything at all, just reply to this email.', '', 'Best,', '{{my_name}}')),
  T('review', 'Sales', 'Ask for a review', 'Would you leave us a quick review?', p('Hi {{first_name}},', '', 'It was a pleasure working with you. If you were happy with us, would you take a minute to leave a review? It really helps a small business like ours.', '', '{{review_link}}', '', 'Thank you!', '{{my_first_name}}')),

  // Money
  T('invoice', 'Money', 'Send an invoice', 'Invoice {{invoice_number}}', p('Hi {{first_name}},', '', 'Please find invoice {{invoice_number}} for {{amount}} attached. Payment is due by {{due_date}}.', '', 'Thank you for your business!', '', '{{my_name}}')),
  T('overdue', 'Money', 'Friendly payment reminder', 'Reminder: invoice {{invoice_number}}', p('Hi {{first_name}},', '', 'A friendly reminder that invoice {{invoice_number}} for {{amount}} was due on {{due_date}}. If you’ve already paid, thank you — please ignore this.', '', 'Best,', '{{my_name}}')),
  T('paid', 'Money', 'Payment received', 'Payment received — thank you', p('Hi {{first_name}},', '', 'We’ve received your payment of {{amount}}. Thank you!', '', 'Best,', '{{my_name}}')),

  // Support
  T('looking', 'Support', 'We’re looking into it', 'We’re on it', p('Hi {{first_name}},', '', 'Thanks for letting us know. We’re looking into {{issue}} now and will update you by {{when}}.', '', 'Sorry for the trouble,', '{{my_first_name}}')),
  T('fixed', 'Support', 'It’s fixed', 'All fixed', p('Hi {{first_name}},', '', 'Good news — {{issue}} is fixed. {{what_we_did}}', '', 'Let us know if anything else comes up.', '', 'Best,', '{{my_first_name}}')),
  T('more-info', 'Support', 'Need more information', 'A couple of quick questions', p('Hi {{first_name}},', '', 'Happy to help. So we can sort this out quickly, could you tell us:', '', '• {{question_1}}', '• {{question_2}}', '', 'Thanks,', '{{my_first_name}}')),

  // Hiring
  T('interview', 'Hiring', 'Invite to interview', 'Interview for {{role}}', p('Hi {{first_name}},', '', 'Thanks for applying for the {{role}} role. We’d love to talk to you. Would {{time_1}} or {{time_2}} work for a {{length}} interview?', '', 'Best,', '{{my_name}}')),
  T('offer', 'Hiring', 'Job offer', 'Offer: {{role}}', p('Hi {{first_name}},', '', 'I’m delighted to offer you the {{role}} role, starting {{start_date}}, at {{salary}}. The full offer letter is attached.', '', 'Please let me know if you have any questions. We really hope you’ll join us!', '', '{{my_name}}')),
  T('not-this-time', 'Hiring', 'Not this time', 'Your application for {{role}}', p('Hi {{first_name}},', '', 'Thank you for your interest in the {{role}} role and for the time you put into applying. We’ve decided to move forward with other candidates this time, but we were glad to meet you and wish you every success.', '', 'Best,', '{{my_name}}')),

  // Real estate
  T('showing', 'Real estate', 'Book a showing', 'Viewing: {{address}}', p('Hi {{first_name}},', '', 'Thanks for your interest in {{address}}. I can show it to you on {{time_1}} or {{time_2}}. Which works better?', '', 'Best,', '{{my_name}}')),
  T('new-listing', 'Real estate', 'New listing for you', 'New listing: {{address}}', p('Hi {{first_name}},', '', 'A new home just came on the market that matches what you’re looking for:', '', '<b>{{address}}</b> — {{price}}, {{beds}} beds', '', 'Want to see it this week?', '', '{{my_name}}')),

  // Away
  T('ooo', 'Away', 'Out of office', 'Out of office until {{return_date}}', p('Hi,', '', 'Thanks for your email. I’m away until {{return_date}} with limited access to email. For anything urgent please contact {{cover_name}} at {{cover_email}}.', '', 'I’ll reply when I’m back.', '', '{{my_name}}')),
];
export const CATEGORIES = [...new Set(GALLERY.map((t) => t.category))];
