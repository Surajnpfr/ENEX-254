#!/usr/bin/env python3
"""Build a shareable EM formula-sheet PDF into em-prep/exports/.

Reads em-prep/data/content.json, writes LaTeX, compiles with pdflatex.
The Formula page Download button serves this static file (no browser rendering).
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EM_PREP = ROOT / "em-prep"
CONTENT = EM_PREP / "data" / "content.json"
EXPORTS = EM_PREP / "exports"
BUILD = ROOT / "build" / "insights-formula-sheet"
TEX_NAME = "formula-sheet"
PDF_OUT = EXPORTS / "ENEX254-EM-Formula-Sheet.pdf"


def tex_escape(text: str) -> str:
    if text is None:
        return ""
    s = str(text)
    # Keep math segments intact
    parts = re.split(r"(\$[^$]+\$)", s)
    out = []
    for p in parts:
        if p.startswith("$") and p.endswith("$"):
            out.append(p)
            continue
        p = p.replace("\\", "\\textbackslash{}")
        for a, b in [
            ("&", r"\&"),
            ("%", r"\%"),
            ("#", r"\#"),
            ("_", r"\_"),
            ("{", r"\{"),
            ("}", r"\}"),
            ("~", r"\textasciitilde{}"),
            ("^", r"\textasciicircum{}"),
        ]:
            p = p.replace(a, b)
        out.append(p)
    return "".join(out)


def split_md_row(line: str) -> list[str]:
    """Split a markdown table row on | while ignoring pipes inside $...$."""
    s = line.strip().strip("|")
    cells: list[str] = []
    buf: list[str] = []
    in_math = False
    i = 0
    while i < len(s):
        ch = s[i]
        if ch == "$":
            in_math = not in_math
            buf.append(ch)
            i += 1
            continue
        if ch == "|" and not in_math:
            cells.append("".join(buf).strip())
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    cells.append("".join(buf).strip())
    return cells


def md_table_to_latex(md: str) -> str:
    lines = [ln.strip() for ln in md.replace("\r\n", "\n").split("\n") if ln.strip()]
    rows = []
    for ln in lines:
        if re.match(r"^\|?[\s\-:|]+\|?$", ln):
            continue
        rows.append(split_md_row(ln))
    if len(rows) < 2:
        return ""
    ncol = max(len(r) for r in rows)
    use_x = ncol >= 3
    env = "tabularx" if use_x else "tabular"
    open_env = (
        rf"\begin{{tabularx}}{{\textwidth}}{{{'|'.join(['X'] * ncol)}}}"
        if use_x
        else rf"\begin{{tabular}}{{{'|'.join(['l'] * ncol)}}}"
    )
    lines_out = [
        r"\begin{center}",
        r"\small",
        open_env,
        r"\toprule",
    ]
    head = rows[0] + [""] * (ncol - len(rows[0]))
    lines_out.append(" & ".join(tex_escape(c) for c in head[:ncol]) + r" \\")
    lines_out.append(r"\midrule")
    for r in rows[1:]:
        cells = (r + [""] * ncol)[:ncol]
        lines_out.append(" & ".join(tex_escape(c) for c in cells) + r" \\")
    lines_out.append(r"\bottomrule")
    lines_out.append(rf"\end{{{env}}}")
    lines_out.append(r"\end{center}")
    return "\n".join(lines_out)


def formula_blocks(data: dict) -> list[dict]:
    chapters = sorted(data.get("chapters") or [], key=lambda c: c.get("number") or 0)
    topics = data.get("topics") or []
    blocks = []
    for ch in chapters:
        ch_topics = [
            t
            for t in topics
            if t.get("chapterId") == ch["id"]
            and ((t.get("formulas") or []) or (t.get("formulaTables") or []))
        ]
        ch_topics.sort(
            key=lambda t: (0 if t.get("isReference") else 1, str(t.get("title") or ""))
        )
        if not ch_topics:
            continue
        count = sum(
            len(t.get("formulas") or []) + len(t.get("formulaTables") or []) for t in ch_topics
        )
        blocks.append({"chapter": ch, "topics": ch_topics, "formulaCount": count})
    return blocks


def build_tex(data: dict) -> str:
    blocks = formula_blocks(data)
    total_items = sum(b["formulaCount"] for b in blocks)
    total_topics = sum(len(b["topics"]) for b in blocks)

    toc_lines = [r"\section*{Contents}", r"\begin{itemize}"]
    for b in blocks:
        ch = b["chapter"]
        toc_lines.append(
            rf"  \item \textbf{{Ch.{ch['number']}}} {tex_escape(ch['title'])}"
            rf" --- {len(b['topics'])} topics, {b['formulaCount']} items"
        )
        toc_lines.append(r"  \begin{itemize}")
        for i, t in enumerate(b["topics"], 1):
            toc_lines.append(
                rf"    \item {ch['number']}.{i}\ {tex_escape(t.get('title') or '')}"
            )
        toc_lines.append(r"  \end{itemize}")
    toc_lines.append(r"\end{itemize}")
    toc_lines.append(r"\newpage")

    body = []
    for b in blocks:
        ch = b["chapter"]
        body.append(rf"\section{{Chapter {ch['number']}: {tex_escape(ch['title'])}}}")
        body.append(
            rf"\noindent\textit{{{len(b['topics'])} topics · {b['formulaCount']} items}}\par\medskip"
        )
        for ti, t in enumerate(b["topics"], 1):
            title = tex_escape(t.get("title") or "")
            ref = r" \textit{(Reference)}" if t.get("isReference") else ""
            body.append(rf"\subsection{{{ch['number']}.{ti}\ {title}{ref}}}")
            for tb in t.get("formulaTables") or []:
                body.append(rf"\subsubsection*{{{tex_escape(tb.get('title') or 'Table')}}}")
                latex_t = md_table_to_latex(tb.get("markdown") or "")
                if latex_t:
                    body.append(latex_t)
                    body.append("")
            for fi, f in enumerate(t.get("formulas") or [], 1):
                f = (f or "").strip()
                if not f:
                    continue
                body.append(rf"\noindent{{\footnotesize {ch['number']}.{ti}.{fi}}}\par")
                body.append(r"\[")
                body.append(f)
                body.append(r"\]")

    return rf"""%% Auto-generated by em-prep/tools/build_formula_pdf.py — do not edit by hand
\documentclass[10pt,a4paper]{{article}}

\usepackage[margin=16mm]{{geometry}}
\usepackage{{amsmath,amssymb,mathtools}}
\usepackage{{booktabs}}
\usepackage{{tabularx}}
\usepackage{{array}}
\usepackage{{fancyhdr}}
\usepackage{{enumitem}}
\usepackage[hidelinks]{{hyperref}}

\setlength{{\headheight}}{{14pt}}
\pagestyle{{fancy}}
\fancyhf{{}}
\lhead{{\small ENEX 254 --- Electromagnetics}}
\rhead{{\small Formula Sheet}}
\cfoot{{\thepage}}
\renewcommand{{\headrulewidth}}{{0.4pt}}
\setlist[itemize]{{leftmargin=1.4em,itemsep=0.15em,topsep=0.2em}}
\setcounter{{secnumdepth}}{{0}}

\begin{{document}}

\begin{{center}}
{{\LARGE\bfseries ENEX 254 --- Electromagnetics}}\\[4pt]
{{\Large Formula Sheet}}\\[6pt]
{{\normalsize Chapter-wise · formulas \& reference tables}}\\[2pt]
{{\small {len(blocks)} chapters · {total_topics} topics · {total_items} items}}
\end{{center}}

\vspace{{0.6em}}
\hrule
\vspace{{1em}}

{chr(10).join(toc_lines)}

{chr(10).join(body)}

\vspace{{1.5em}}
\hrule
\vspace{{0.5em}}
\noindent{{\small EM Exam Prep --- formulas only. Rebuild: \texttt{{python em-prep/tools/build\_formula\_pdf.py}}}}

\end{{document}}
"""


def compile_pdf(tex_source: str) -> Path:
    BUILD.mkdir(parents=True, exist_ok=True)
    EXPORTS.mkdir(parents=True, exist_ok=True)
    tex_path = BUILD / f"{TEX_NAME}.tex"
    tex_path.write_text(tex_source, encoding="utf-8")

    pdflatex = shutil.which("pdflatex")
    if not pdflatex:
        raise RuntimeError("pdflatex not found on PATH")

    cmd = [
        pdflatex,
        "-interaction=nonstopmode",
        "-halt-on-error",
        f"-output-directory={BUILD}",
        str(tex_path),
    ]
    # Two passes for stable refs
    for _ in range(2):
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if proc.returncode != 0:
            log = BUILD / f"{TEX_NAME}.log"
            tail = log.read_text(encoding="utf-8", errors="replace")[-4000:] if log.exists() else proc.stderr
            raise RuntimeError(f"pdflatex failed:\n{tail}")

    built = BUILD / f"{TEX_NAME}.pdf"
    if not built.exists():
        raise RuntimeError("PDF was not produced")
    shutil.copy2(built, PDF_OUT)
    return PDF_OUT


def main() -> int:
    if not CONTENT.exists():
        print(f"Missing {CONTENT} — run build_content.py first", file=sys.stderr)
        return 1
    data = json.loads(CONTENT.read_text(encoding="utf-8"))
    tex = build_tex(data)
    out = compile_pdf(tex)
    print(f"Wrote {out}")
    print(f"  size={out.stat().st_size // 1024} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
