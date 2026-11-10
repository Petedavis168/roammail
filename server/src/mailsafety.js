// Incoming mail safety, shown on every email:
//  - every message was checked by the mail server on arrival (rspamd: spam, phishing and ClamAV virus scanning);
//    mail carrying a virus is rejected or held in quarantine, so it never reaches the inbox
//  - attachments that can run code on a computer (programs, scripts, shortcuts, disk images) are blocked unless you
//    confirm; Office files with macros and archives get a warning
const BLOCK = /\.(exe|scr|com|bat|cmd|pif|vbs|vbe|js|jse|wsf|wsh|ws|ps1|psm1|msi|msp|mst|hta|cpl|jar|lnk|reg|scf|inf|application|gadget|iso|img|vhd|vhdx|dll|sys|appx|appxbundle|msix|apk|dmg|pkg|sh|command|url|chm|xll|svg\.html?|html?\.exe)$/i;
const MACRO = /\.(docm|dotm|xlsm|xltm|xlam|pptm|potm|ppam|ppsm|sldm|xlsb)$/i;
const ARCHIVE = /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|cab|ace|arj|lzh)$/i;
const DOUBLE = /\.(pdf|docx?|xlsx?|pptx?|jpe?g|png|txt|zip)\.[a-z0-9]{2,5}$/i; // "invoice.pdf.exe"

/** 'block' | 'macro' | 'archive' | 'html' | null */
export function attachmentRisk(filename, contentType) {
  const n = String(filename || '').trim().toLowerCase().replace(/[\s.]+$/, '');
  const ct = String(contentType || '').toLowerCase();
  if (BLOCK.test(n) || (DOUBLE.test(n) && BLOCK.test(n)) || /x-msdownload|x-msdos-program|x-sh\b|java-archive|x-ms-installer|vnd\.microsoft\.portable-executable/.test(ct)) return 'block';
  if (/\.(html?|shtml|xhtml|svg)$/i.test(n) || /^text\/html|image\/svg/.test(ct)) return 'html'; // phishing pages are often sent as attachments
  if (MACRO.test(n) || /macroenabled/.test(ct)) return 'macro';
  if (ARCHIVE.test(n) || /zip|x-rar|x-7z/.test(ct)) return 'archive';
  return null;
}

/** What the mail server's checks said about this message (from its headers). */
export function scanInfo(parsed) {
  const h = parsed.headers;
  const spamd = [].concat(h.get('x-spamd-result') || []).map(String).join(' ');
  const checked = !!(spamd || h.get('x-rspamd-queue-id') || h.get('x-rspamd-server') || h.get('x-spamd-bar'));
  const virus = /\b(CLAM_VIRUS|CLAMAV_VIRUS|FPROT_VIRUS|AVAST_VIRUS|SOPHOS_VIRUS|KAS_VIRUS|ICAP_VIRUS)\b/.test(spamd);
  const phish = /\b(PHISHING|PHISHED_[A-Z]+|PHISH_[A-Z]+|URIBL_BLACK|DBL_PHISH|SURBL_BLOCKED|RSPAMD_URIBL)\b/.test(spamd);
  return { checked, virus, phish };
}
