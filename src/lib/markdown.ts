// Tiny, dependency-free markdown renderer for note widgets.
// Supports headings, bold/italic, inline + fenced code, links, lists,
// blockquotes, hr, and paragraphs. HTML is escaped before formatting.

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\b_([^_]+)_\b/g, '<em>$1</em>')
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
    )
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  let listType: 'ul' | 'ol' | null = null

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`)
      listType = null
    }
  }

  while (i < lines.length) {
    const line = lines[i]

    // fenced code
    if (/^```/.test(line)) {
      closeList()
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(esc(lines[i]))
        i++
      }
      i++ // skip closing fence
      out.push(`<pre><code>${buf.join('\n')}</code></pre>`)
      continue
    }

    // headings
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      closeList()
      const lvl = h[1].length
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`)
      i++
      continue
    }

    // hr
    if (/^\s*([-*_])\1\1+\s*$/.test(line)) {
      closeList()
      out.push('<hr />')
      i++
      continue
    }

    // blockquote
    if (/^>\s?/.test(line)) {
      closeList()
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`)
      i++
      continue
    }

    // task checkbox: `- [ ]`, `- []`, `- [x]`, or a bare `[ ] text` (no marker).
    // the box may be empty (`[]`), a space (`[ ]`), or x/X (checked).
    const task = /^\s*(?:[-*+]\s+)?\[([ xX]?)\]\s*(.*)$/.exec(line)
    if (task) {
      if (listType !== 'ul') {
        closeList()
        out.push('<ul>')
        listType = 'ul'
      }
      const done = /[xX]/.test(task[1])
      // data-line carries the source line index so a click can toggle it
      out.push(
        `<li class="md-task${done ? ' md-task--done' : ''}">` +
          `<span class="md-check${done ? ' md-check--done' : ''}" data-line="${i}" role="checkbox" aria-checked="${done}"></span>` +
          `<span class="md-task-text">${inline(task[2])}</span>` +
          `</li>`,
      )
      i++
      continue
    }

    // unordered list
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (ul) {
      if (listType !== 'ul') {
        closeList()
        out.push('<ul>')
        listType = 'ul'
      }
      out.push(`<li>${inline(ul[1])}</li>`)
      i++
      continue
    }

    // ordered list
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line)
    if (ol) {
      if (listType !== 'ol') {
        closeList()
        out.push('<ol>')
        listType = 'ol'
      }
      out.push(`<li>${inline(ol[1])}</li>`)
      i++
      continue
    }

    // blank line
    if (/^\s*$/.test(line)) {
      closeList()
      i++
      continue
    }

    // paragraph (gather consecutive non-empty lines)
    closeList()
    const para: string[] = [line]
    i++
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^(#{1,6}\s|```|>|\s*[-*+]\s|\s*\d+\.\s|\s*\[[ xX]?\])/.test(lines[i])
    ) {
      para.push(lines[i])
      i++
    }
    out.push(`<p>${inline(para.join(' '))}</p>`)
  }

  closeList()
  return out.join('\n')
}
