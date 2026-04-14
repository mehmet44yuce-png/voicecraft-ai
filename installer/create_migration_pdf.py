"""Taşıma rehberi PDF'i oluşturur.

Kullanım:
    python installer/create_migration_pdf.py
Çıktı:
    Tasinma_Rehberi.pdf
"""
import os
import re
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.lib import colors
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer,
                                 Table, TableStyle, PageBreak, Preformatted)
from reportlab.lib.enums import TA_LEFT, TA_CENTER

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MD_PATH = os.path.join(ROOT, 'TASINMA_REHBERI.md')
OUT_PATH = os.path.join(ROOT, 'Tasinma_Rehberi.pdf')


def build_styles():
    ss = getSampleStyleSheet()
    styles = {
        'title': ParagraphStyle('title', parent=ss['Title'], fontSize=22,
                                textColor=colors.HexColor('#0f4c75'),
                                spaceAfter=18, alignment=TA_CENTER),
        'h1': ParagraphStyle('h1', parent=ss['Heading1'], fontSize=16,
                             textColor=colors.HexColor('#0f4c75'),
                             spaceBefore=14, spaceAfter=8,
                             borderPadding=4,
                             borderColor=colors.HexColor('#3282b8'),
                             borderWidth=0),
        'h2': ParagraphStyle('h2', parent=ss['Heading2'], fontSize=13,
                             textColor=colors.HexColor('#1b6ca8'),
                             spaceBefore=10, spaceAfter=6),
        'h3': ParagraphStyle('h3', parent=ss['Heading3'], fontSize=11,
                             textColor=colors.HexColor('#444'),
                             spaceBefore=6, spaceAfter=4),
        'body': ParagraphStyle('body', parent=ss['BodyText'], fontSize=10,
                               leading=14, spaceAfter=4, alignment=TA_LEFT),
        'bullet': ParagraphStyle('bullet', parent=ss['BodyText'], fontSize=10,
                                 leading=13, leftIndent=14, bulletIndent=4,
                                 spaceAfter=2),
        'code': ParagraphStyle('code', parent=ss['Code'], fontSize=9,
                               leading=11, backColor=colors.HexColor('#f3f3f3'),
                               borderColor=colors.HexColor('#ddd'),
                               borderWidth=0.5, borderPadding=6,
                               leftIndent=6, rightIndent=6,
                               spaceAfter=6, spaceBefore=2,
                               fontName='Courier'),
    }
    return styles


def inline_md(text):
    """Markdown inline -> reportlab mini HTML."""
    # `code`
    text = re.sub(r'`([^`]+)`', r'<font face="Courier" color="#b5182b">\1</font>', text)
    # **bold**
    text = re.sub(r'\*\*([^*]+)\*\*', r'<b>\1</b>', text)
    # *italic*
    text = re.sub(r'(?<!\*)\*([^*]+)\*(?!\*)', r'<i>\1</i>', text)
    # links [txt](url)
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)',
                  r'<link href="\2" color="#1b6ca8"><u>\1</u></link>', text)
    return text


def parse_md_to_flowables(md, styles):
    flow = []
    lines = md.split('\n')
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        # H1
        if stripped.startswith('# '):
            flow.append(Paragraph(inline_md(stripped[2:]), styles['title']))
            i += 1
            continue
        # H2
        if stripped.startswith('## '):
            flow.append(Paragraph(inline_md(stripped[3:]), styles['h1']))
            i += 1
            continue
        # H3
        if stripped.startswith('### '):
            flow.append(Paragraph(inline_md(stripped[4:]), styles['h2']))
            i += 1
            continue
        # H4
        if stripped.startswith('#### '):
            flow.append(Paragraph(inline_md(stripped[5:]), styles['h3']))
            i += 1
            continue

        # Code block
        if stripped.startswith('```'):
            i += 1
            buf = []
            while i < len(lines) and not lines[i].strip().startswith('```'):
                buf.append(lines[i])
                i += 1
            i += 1
            code = '\n'.join(buf)
            flow.append(Preformatted(code, styles['code']))
            continue

        # Horizontal rule
        if stripped == '---':
            flow.append(Spacer(1, 6))
            flow.append(Table([['']], colWidths=[17*cm], rowHeights=[0.5],
                              style=TableStyle([('LINEABOVE', (0,0), (-1,-1), 0.5, colors.HexColor('#ccc'))])))
            flow.append(Spacer(1, 4))
            i += 1
            continue

        # Table
        if stripped.startswith('|') and i+1 < len(lines) and re.match(r'^\|[\s:|-]+\|$', lines[i+1].strip()):
            rows = []
            while i < len(lines) and lines[i].strip().startswith('|'):
                row = [c.strip() for c in lines[i].strip().strip('|').split('|')]
                rows.append(row)
                i += 1
            # rows[1] is separator
            header = rows[0]
            body = rows[2:]
            data = [[Paragraph(inline_md(c), styles['body']) for c in header]]
            for r in body:
                data.append([Paragraph(inline_md(c), styles['body']) for c in r])
            t = Table(data, hAlign='LEFT', repeatRows=1)
            t.setStyle(TableStyle([
                ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#0f4c75')),
                ('TEXTCOLOR', (0,0), (-1,0), colors.white),
                ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
                ('GRID', (0,0), (-1,-1), 0.3, colors.HexColor('#bbb')),
                ('VALIGN', (0,0), (-1,-1), 'TOP'),
                ('LEFTPADDING', (0,0), (-1,-1), 5),
                ('RIGHTPADDING', (0,0), (-1,-1), 5),
                ('TOPPADDING', (0,0), (-1,-1), 4),
                ('BOTTOMPADDING', (0,0), (-1,-1), 4),
            ]))
            flow.append(t)
            flow.append(Spacer(1, 6))
            continue

        # Bullet / numbered list
        m = re.match(r'^(\s*)([-*]|\d+\.)\s+(.*)$', line)
        if m:
            text = inline_md(m.group(3))
            bullet = '•' if m.group(2) in ('-', '*') else m.group(2)
            flow.append(Paragraph(f'{bullet} {text}', styles['bullet']))
            i += 1
            continue

        # Blank line
        if not stripped:
            flow.append(Spacer(1, 4))
            i += 1
            continue

        # Normal paragraph
        flow.append(Paragraph(inline_md(stripped), styles['body']))
        i += 1

    return flow


def main():
    with open(MD_PATH, 'r', encoding='utf-8') as f:
        md = f.read()

    styles = build_styles()
    flow = parse_md_to_flowables(md, styles)

    doc = SimpleDocTemplate(OUT_PATH, pagesize=A4,
                            leftMargin=2*cm, rightMargin=2*cm,
                            topMargin=1.8*cm, bottomMargin=1.8*cm,
                            title='VoiceCraft AI - Tasinma Rehberi',
                            author='VoiceCraft Dev')
    doc.build(flow)
    print(f'[OK] PDF olusturuldu: {OUT_PATH}')
    print(f'     Boyut: {os.path.getsize(OUT_PATH)/1024:.1f} KB')


if __name__ == '__main__':
    main()
