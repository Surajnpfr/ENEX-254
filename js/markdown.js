/** Lightweight Markdown → HTML (math left for MathJax) */

export function renderMarkdown(src = '') {
  if (!src) return '';
  let text = String(src).replace(/\r\n?/g, '\n');
  // protect math
  const slots = [];
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => {
    slots.push(`$$${m}$$`);
    return `%%MATH${slots.length - 1}%%`;
  });
  text = text.replace(/\$([^$\n]+?)\$/g, (_, m) => {
    slots.push(`$${m}$`);
    return `%%MATH${slots.length - 1}%%`;
  });

  // escape HTML outside math
  text = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // code fences
  text = text.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code.trim()}</code></pre>`);
  // tables (simple) — allow CRLF-normalized newlines
  text = text.replace(/(^\|.+\|\n\|[-: \t|]+\|\n(?:\|.+\|\n?)*)/gm, (block) => {
    const rows = block.trim().split('\n').filter(Boolean);
    if (rows.length < 2) return block;
    const parseRow = (r) =>
      r
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim());
    const head = parseRow(rows[0]);
    const body = rows.slice(2).map(parseRow);
    return `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body
      .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
      .join('')}</tbody></table>`;
  });

  // headings
  text = text.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  text = text.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  text = text.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  // bold / italic
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // lists
  text = text.replace(/^(?:- |\* )(.+)$/gm, '<li>$1</li>');
  text = text.replace(/(?:<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
  // paragraphs
  text = text
    .split(/\n{2,}/)
    .map((block) => {
      const b = block.trim();
      if (!b) return '';
      if (/^<(h\d|ul|ol|table|pre|blockquote)/.test(b)) return b;
      if (b.includes('<li>')) return b;
      return `<p>${b.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');

  // Restore math with < > escaped so innerHTML does not eat `$y<0$` as a tag.
  text = text.replace(/%%MATH(\d+)%%/g, (_, i) => {
    const raw = slots[Number(i)] || '';
    return raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  });
  return text;
}

export async function typeset(el) {
  if (!el) return;
  if (window.MathJax?.typesetPromise) {
    try {
      await window.MathJax.typesetPromise([el]);
    } catch (e) {
      console.warn('MathJax typeset failed', e);
    }
  }
}
