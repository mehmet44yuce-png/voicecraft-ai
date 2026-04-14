"""Synergy Kendiyas Fabric — Kurulum ve Kullanim Kilavuzu PDF"""
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm, mm
from reportlab.lib.colors import HexColor
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, HRFlowable
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_JUSTIFY
import os

OUTPUT = os.path.join(os.path.dirname(__file__), 'dist', 'Synergy-Kendiyas-Fabric',
                      'Synergy Kendiyas Fabric - Kurulum Kilavuzu.pdf')

# Renkler
DARK_BG = HexColor('#0f172a')
BLUE = HexColor('#3b82f6')
GREEN = HexColor('#22c55e')
PURPLE = HexColor('#a855f7')
ORANGE = HexColor('#f59e0b')
RED = HexColor('#ef4444')
GRAY = HexColor('#64748b')
DARK = HexColor('#1e293b')
WHITE = HexColor('#ffffff')
LIGHT = HexColor('#e2e8f0')

def build():
    doc = SimpleDocTemplate(OUTPUT, pagesize=A4,
                           topMargin=2*cm, bottomMargin=2*cm,
                           leftMargin=2.5*cm, rightMargin=2.5*cm)

    styles = getSampleStyleSheet()

    # Ozel stiller
    title_style = ParagraphStyle('Title2', parent=styles['Title'],
        fontSize=28, textColor=BLUE, spaceAfter=10, alignment=TA_CENTER,
        fontName='Helvetica-Bold')

    subtitle_style = ParagraphStyle('Subtitle2', parent=styles['Normal'],
        fontSize=14, textColor=GRAY, spaceAfter=30, alignment=TA_CENTER)

    h1 = ParagraphStyle('H1', parent=styles['Heading1'],
        fontSize=20, textColor=BLUE, spaceBefore=20, spaceAfter=12,
        fontName='Helvetica-Bold', borderWidth=0, borderPadding=0,
        borderColor=BLUE)

    h2 = ParagraphStyle('H2', parent=styles['Heading2'],
        fontSize=15, textColor=PURPLE, spaceBefore=16, spaceAfter=8,
        fontName='Helvetica-Bold')

    h3 = ParagraphStyle('H3', parent=styles['Heading3'],
        fontSize=12, textColor=ORANGE, spaceBefore=10, spaceAfter=6,
        fontName='Helvetica-Bold')

    body = ParagraphStyle('Body2', parent=styles['Normal'],
        fontSize=10.5, textColor=DARK, spaceAfter=6, leading=16,
        alignment=TA_JUSTIFY)

    code_style = ParagraphStyle('Code2', parent=styles['Code'],
        fontSize=9, textColor=WHITE, backColor=DARK,
        borderWidth=1, borderColor=GRAY, borderPadding=8,
        spaceAfter=10, leading=14, fontName='Courier')

    note_style = ParagraphStyle('Note2', parent=styles['Normal'],
        fontSize=10, textColor=HexColor('#1e40af'), backColor=HexColor('#eff6ff'),
        borderWidth=1, borderColor=BLUE, borderPadding=10,
        spaceAfter=12, leading=14)

    warn_style = ParagraphStyle('Warn2', parent=styles['Normal'],
        fontSize=10, textColor=HexColor('#92400e'), backColor=HexColor('#fffbeb'),
        borderWidth=1, borderColor=ORANGE, borderPadding=10,
        spaceAfter=12, leading=14)

    bullet = ParagraphStyle('Bullet2', parent=styles['Normal'],
        fontSize=10.5, textColor=DARK, spaceAfter=4, leading=15,
        leftIndent=20, bulletIndent=8)

    story = []

    # ═══════════════════════════════════════════════
    # KAPAK
    # ═══════════════════════════════════════════════
    story.append(Spacer(1, 4*cm))
    story.append(Paragraph('Synergy Kendiyas Fabric', title_style))
    story.append(Paragraph('AI Ses ve Video Editoru', subtitle_style))
    story.append(Spacer(1, 1*cm))
    story.append(HRFlowable(width='60%', thickness=2, color=BLUE))
    story.append(Spacer(1, 1*cm))
    story.append(Paragraph('Kurulum ve Kullanim Kilavuzu', ParagraphStyle('Sub3',
        parent=styles['Normal'], fontSize=16, textColor=DARK, alignment=TA_CENTER)))
    story.append(Spacer(1, 2*cm))

    version_data = [
        ['Versiyon:', '1.0.0'],
        ['Tarih:', 'Nisan 2026'],
        ['Platform:', 'Windows 10/11 (64-bit)'],
        ['Lisans:', 'Ozel Kullanim'],
    ]
    version_table = Table(version_data, colWidths=[4*cm, 8*cm])
    version_table.setStyle(TableStyle([
        ('FONTNAME', (0,0), (0,-1), 'Helvetica-Bold'),
        ('FONTSIZE', (0,0), (-1,-1), 10),
        ('TEXTCOLOR', (0,0), (0,-1), GRAY),
        ('TEXTCOLOR', (1,0), (1,-1), DARK),
        ('ALIGN', (0,0), (-1,-1), 'LEFT'),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('TOPPADDING', (0,0), (-1,-1), 4),
        ('BOTTOMPADDING', (0,0), (-1,-1), 4),
    ]))
    story.append(version_table)
    story.append(PageBreak())

    # ═══════════════════════════════════════════════
    # ICINDEKILER
    # ═══════════════════════════════════════════════
    story.append(Paragraph('Icindekiler', h1))
    story.append(HRFlowable(width='100%', thickness=1, color=BLUE))
    story.append(Spacer(1, 0.5*cm))

    toc = [
        '1. Sistem Gereksinimleri',
        '2. Kurulum (Setup.bat)',
        '3. Programi Baslatma',
        '4. Ses Modulu Kullanimi',
        '5. Video Modulu Kullanimi',
        '6. Admin Panel',
        '7. Sik Sorulan Sorular',
        '8. Sorun Giderme',
    ]
    for item in toc:
        story.append(Paragraph(item, ParagraphStyle('TOC', parent=body,
            fontSize=12, spaceAfter=8, textColor=BLUE)))

    story.append(PageBreak())

    # ═══════════════════════════════════════════════
    # 1. SISTEM GEREKSINIMLERI
    # ═══════════════════════════════════════════════
    story.append(Paragraph('1. Sistem Gereksinimleri', h1))
    story.append(HRFlowable(width='100%', thickness=1, color=BLUE))

    req_data = [
        ['Bilesen', 'Minimum', 'Onerilen'],
        ['Isletim Sistemi', 'Windows 10 64-bit', 'Windows 11 64-bit'],
        ['Islemci', 'Intel i5 / AMD Ryzen 5', 'Intel i7 / AMD Ryzen 7+'],
        ['RAM', '16 GB', '32 GB+'],
        ['Ekran Karti', 'Herhangi (CPU modu)', 'NVIDIA RTX 3060+ (CUDA)'],
        ['Disk Alani', '10 GB', '20 GB+'],
        ['Internet', 'Ilk kurulum icin gerekli', 'Model indirme icin'],
    ]
    req_table = Table(req_data, colWidths=[4*cm, 5*cm, 5*cm])
    req_table.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), BLUE),
        ('TEXTCOLOR', (0,0), (-1,0), WHITE),
        ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
        ('FONTSIZE', (0,0), (-1,-1), 9),
        ('ALIGN', (0,0), (-1,-1), 'LEFT'),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('GRID', (0,0), (-1,-1), 0.5, GRAY),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [WHITE, HexColor('#f8fafc')]),
        ('TOPPADDING', (0,0), (-1,-1), 6),
        ('BOTTOMPADDING', (0,0), (-1,-1), 6),
        ('LEFTPADDING', (0,0), (-1,-1), 8),
    ]))
    story.append(Spacer(1, 0.3*cm))
    story.append(req_table)

    story.append(Paragraph('<b>NOT:</b> NVIDIA GPU varsa islemler 5-10 kat daha hizli calisir. '
                          'GPU olmadan da calisir (CPU modu).', note_style))

    # ═══════════════════════════════════════════════
    # 2. KURULUM
    # ═══════════════════════════════════════════════
    story.append(PageBreak())
    story.append(Paragraph('2. Kurulum', h1))
    story.append(HRFlowable(width='100%', thickness=1, color=BLUE))

    story.append(Paragraph('Adim 1: Dosyalari Cikartin', h2))
    story.append(Paragraph('Indirdiginiz ZIP dosyasini istediginiz bir klasore cikartin. '
                          'Ornegin: <b>D:\\Programs\\Synergy-Kendiyas-Fabric\\</b>', body))

    story.append(Paragraph('Adim 2: Setup.bat Calistirin', h2))
    story.append(Paragraph('<b>Setup.bat</b> dosyasina cift tiklayin. Kurulum sihirbazi acilacak.', body))
    story.append(Paragraph('Sihirbaz 6 adimda kurulumu tamamlar:', body))

    steps = [
        ['Adim', 'Islem', 'Sure'],
        ['1/6', 'Python 3.12 kurulumu', '2-3 dk'],
        ['2/6', 'FFmpeg kurulumu', '1 dk'],
        ['3/6', 'PyTorch + CUDA (GPU destegi)', '5-10 dk'],
        ['4/6', 'AI modelleri (Whisper, Demucs, vs.)', '5-15 dk'],
        ['5/6', 'Ayarlar (HuggingFace Token)', '1 dk'],
        ['6/6', 'Kurulum tamamlandi!', '-'],
    ]
    step_table = Table(steps, colWidths=[2*cm, 8*cm, 3*cm])
    step_table.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), PURPLE),
        ('TEXTCOLOR', (0,0), (-1,0), WHITE),
        ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
        ('FONTSIZE', (0,0), (-1,-1), 9),
        ('GRID', (0,0), (-1,-1), 0.5, GRAY),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [WHITE, HexColor('#faf5ff')]),
        ('TOPPADDING', (0,0), (-1,-1), 5),
        ('BOTTOMPADDING', (0,0), (-1,-1), 5),
        ('LEFTPADDING', (0,0), (-1,-1), 8),
    ]))
    story.append(step_table)

    story.append(Spacer(1, 0.3*cm))
    story.append(Paragraph('Her adimda <b>[I]leri</b> ve <b>[G]eri</b> secenekleri ile ilerleyebilirsiniz. '
                          'Zaten kurulu olan bilesenler otomatik atlanir.', body))

    story.append(Paragraph('<b>ONEMLI:</b> Python kurulumu sirasinda "Add Python to PATH" '
                          'secenegini mutlaka isaretleyin!', warn_style))

    # ═══════════════════════════════════════════════
    # 3. BASLATMA
    # ═══════════════════════════════════════════════
    story.append(PageBreak())
    story.append(Paragraph('3. Programi Baslatma', h1))
    story.append(HRFlowable(width='100%', thickness=1, color=BLUE))

    story.append(Paragraph('<b>Synergy-Kendiyas-Fabric.bat</b> dosyasina cift tiklayin.', body))
    story.append(Paragraph('Program sunucuyu baslatacak ve tarayicinizda otomatik olarak '
                          '<b>http://localhost:3000</b> adresini acacaktir.', body))

    story.append(Paragraph('Ekranda ust kisimda iki ana sekme goreceksiniz:', body))

    tab_data = [
        ['Sekme', 'Islem'],
        ['Ses', 'Ses dosyasi yukle, AI pipeline ile temizle, indir'],
        ['Video', 'Video yukle, sesi temizle, sessiz bolgeleri kes, indir'],
    ]
    tab_table = Table(tab_data, colWidths=[3*cm, 11*cm])
    tab_table.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), GREEN),
        ('TEXTCOLOR', (0,0), (-1,0), WHITE),
        ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
        ('FONTSIZE', (0,0), (-1,-1), 10),
        ('GRID', (0,0), (-1,-1), 0.5, GRAY),
        ('TOPPADDING', (0,0), (-1,-1), 6),
        ('BOTTOMPADDING', (0,0), (-1,-1), 6),
        ('LEFTPADDING', (0,0), (-1,-1), 8),
    ]))
    story.append(tab_table)

    story.append(Paragraph('<b>Kapatmak icin:</b> BAT penceresini kapatin veya Ctrl+C basin.', note_style))

    # ═══════════════════════════════════════════════
    # 4. SES MODULU
    # ═══════════════════════════════════════════════
    story.append(Paragraph('4. Ses Modulu Kullanimi', h1))
    story.append(HRFlowable(width='100%', thickness=1, color=BLUE))

    story.append(Paragraph('1. "Ac" butonuna tiklayin ve ses dosyanizi secin (MP3, WAV, M4A, vs.)', bullet))
    story.append(Paragraph('2. Proje adi girin ve "Basla" tiklayin', bullet))
    story.append(Paragraph('3. Pipeline otomatik baslar — adimlar sirasiyla calisir', bullet))
    story.append(Paragraph('4. Her adim tamamlandiginda sonucu dinleyebilirsiniz', bullet))
    story.append(Paragraph('5. Pipeline bittiginde temizlenmis ses dosyasini indirin', bullet))

    story.append(Paragraph('Pipeline Adimlari (13 Adim)', h2))

    pipe_data = [
        ['#', 'Adim', 'Aciklama'],
        ['1', 'Whisper', 'Konusmayi yaziya cevirir (99 dil)'],
        ['1b', 'Ollama', 'Transkript metnini temizler'],
        ['2', 'Demucs', 'Vokal izolasyonu — arka plan ayrilir'],
        ['3', 'NoiseReduce', 'Frekans bazli gurultu bastirma'],
        ['4', 'DNS64', 'Anlik gurultuleri siler (oksuruk, vs.)'],
        ['5', 'SpeechOnly', 'Konusma disi sesleri temizler'],
        ['6', 'Diarize', 'Konusmaci tespiti (kim konusuyor)'],
        ['7', 'VAD', 'Sessizlik haritasi olusturur'],
        ['8', 'Normalize', 'Ses seviyelerini dengeler'],
        ['9', 'Kesim', 'Sessiz bolgeleri keser'],
        ['10a', 'VoiceFixer', 'Ses restorasyonu (opsiyonel)'],
        ['10b', 'Resemble', 'Yapay zeka gurultu temizleme (opsiyonel)'],
        ['10c', 'DeepFilter', 'Derin filtreleme (opsiyonel)'],
    ]
    pipe_table = Table(pipe_data, colWidths=[1.2*cm, 3*cm, 9.5*cm])
    pipe_table.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), BLUE),
        ('TEXTCOLOR', (0,0), (-1,0), WHITE),
        ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
        ('FONTSIZE', (0,0), (-1,-1), 8.5),
        ('GRID', (0,0), (-1,-1), 0.5, GRAY),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [WHITE, HexColor('#f0f9ff')]),
        ('TOPPADDING', (0,0), (-1,-1), 4),
        ('BOTTOMPADDING', (0,0), (-1,-1), 4),
        ('LEFTPADDING', (0,0), (-1,-1), 6),
    ]))
    story.append(pipe_table)

    # ═══════════════════════════════════════════════
    # 5. VIDEO MODULU
    # ═══════════════════════════════════════════════
    story.append(PageBreak())
    story.append(Paragraph('5. Video Modulu Kullanimi', h1))
    story.append(HRFlowable(width='100%', thickness=1, color=BLUE))

    story.append(Paragraph('Video modulu 4 sekmeden olusur:', body))

    vtab_data = [
        ['Sekme', 'Islem'],
        ['Onizleme', 'Video oynatma, bilgi gosterme, ekran goruntusu'],
        ['Ses Isleme', 'Pipeline adimlari secme ve calistirma'],
        ['AI Analiz', 'Claude Vision ile sahne analizi'],
        ['Altyazi', 'Whisper transkriptinden SRT olusturma'],
    ]
    vtab_table = Table(vtab_data, colWidths=[3*cm, 11*cm])
    vtab_table.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), PURPLE),
        ('TEXTCOLOR', (0,0), (-1,0), WHITE),
        ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
        ('FONTSIZE', (0,0), (-1,-1), 9.5),
        ('GRID', (0,0), (-1,-1), 0.5, GRAY),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [WHITE, HexColor('#faf5ff')]),
        ('TOPPADDING', (0,0), (-1,-1), 5),
        ('BOTTOMPADDING', (0,0), (-1,-1), 5),
        ('LEFTPADDING', (0,0), (-1,-1), 8),
    ]))
    story.append(vtab_table)

    story.append(Paragraph('Video Isleme Adimlari', h2))
    story.append(Paragraph('1. "Video" sekmesine gecin', bullet))
    story.append(Paragraph('2. "Video Ac" ile video dosyanizi secin (MP4, WebM, MOV)', bullet))
    story.append(Paragraph('3. "Ses Isleme" sekmesine gecin', bullet))
    story.append(Paragraph('4. Calistirmak istediginiz adimlari checkbox ile secin', bullet))
    story.append(Paragraph('5. "Sesi Cikar ve Pipeline Baslat" butonuna basin', bullet))
    story.append(Paragraph('6. Pipeline tamamlandiginda "Kesilmis Videoyu Indir" basin', bullet))

    story.append(Paragraph('Video Pipeline (10 Adim)', h2))

    vpipe_data = [
        ['#', 'Adim', 'Aciklama'],
        ['1', 'Whisper', 'Video sesini yaziya cevirir'],
        ['2', 'Demucs', 'Vokal izolasyonu'],
        ['3', 'NoiseReduce', 'Gurultu bastirma (GPU)'],
        ['4', 'DNS64', 'Anlik gurultu temizleme'],
        ['5', 'SpeechOnly', 'Konusma disi ses temizleme'],
        ['6', 'VAD', 'Sessizlik haritasi'],
        ['7', 'Diarize', 'Konusmaci tespiti'],
        ['8', 'Normalize', 'Ses seviyesi dengeleme'],
        ['9', 'Kesim', 'Sessiz bolgeleri kes'],
        ['10', 'DeepFilter', 'Derin filtreleme (opsiyonel)'],
    ]
    vpipe_table = Table(vpipe_data, colWidths=[1.2*cm, 3*cm, 9.5*cm])
    vpipe_table.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), PURPLE),
        ('TEXTCOLOR', (0,0), (-1,0), WHITE),
        ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
        ('FONTSIZE', (0,0), (-1,-1), 8.5),
        ('GRID', (0,0), (-1,-1), 0.5, GRAY),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [WHITE, HexColor('#faf5ff')]),
        ('TOPPADDING', (0,0), (-1,-1), 4),
        ('BOTTOMPADDING', (0,0), (-1,-1), 4),
        ('LEFTPADDING', (0,0), (-1,-1), 6),
    ]))
    story.append(vpipe_table)

    story.append(Paragraph('<b>Resume Ozelligi:</b> Her adimin sonucu kaydedilir. '
                          'Sayfa yenilense bile kaldiginiz yerden devam edebilirsiniz. '
                          'Her adimda "Dinle" ve "Buradan Devam" butonlari vardir.', note_style))

    # ═══════════════════════════════════════════════
    # 6. ADMIN PANEL
    # ═══════════════════════════════════════════════
    story.append(PageBreak())
    story.append(Paragraph('6. Admin Panel', h1))
    story.append(HRFlowable(width='100%', thickness=1, color=BLUE))

    story.append(Paragraph('Admin panele <b>http://localhost:3000/admin.html</b> adresinden ulasabilirsiniz.', body))

    admin_data = [
        ['Sekme', 'Islem'],
        ['Sistem Durumu', 'CPU, RAM, GPU, disk kullanimi'],
        ['Proje Yonetimi', 'Kayitli projeleri goruntuele/sil'],
        ['Veritabani', 'IndexedDB store boyutlari'],
        ['Model Yonetimi', 'AI model listesi ve VRAM kullanimi'],
        ['Islem Ayarlari', 'Pipeline adimlari, HF Token, ses parametreleri'],
        ['Yedekleme', 'Tam yedek al (dosya + DB)'],
    ]
    admin_table = Table(admin_data, colWidths=[4*cm, 10*cm])
    admin_table.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), ORANGE),
        ('TEXTCOLOR', (0,0), (-1,0), WHITE),
        ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
        ('FONTSIZE', (0,0), (-1,-1), 9.5),
        ('GRID', (0,0), (-1,-1), 0.5, GRAY),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [WHITE, HexColor('#fffbeb')]),
        ('TOPPADDING', (0,0), (-1,-1), 5),
        ('BOTTOMPADDING', (0,0), (-1,-1), 5),
        ('LEFTPADDING', (0,0), (-1,-1), 8),
    ]))
    story.append(admin_table)

    # ═══════════════════════════════════════════════
    # 7. SSS
    # ═══════════════════════════════════════════════
    story.append(Paragraph('7. Sik Sorulan Sorular', h1))
    story.append(HRFlowable(width='100%', thickness=1, color=BLUE))

    faqs = [
        ('GPU olmadan calisir mi?', 'Evet, CPU modunda calisir ama islemler 5-10 kat yavas olur.'),
        ('Hangi video formatlarini destekler?', 'MP4, WebM, MOV ve FFmpeg destekleyen tum formatlar.'),
        ('Hangi ses formatlarini destekler?', 'MP3, WAV, M4A, FLAC, OGG ve daha fazlasi.'),
        ('Maksimum dosya boyutu nedir?', '15 GB a kadar dosya yuklenebilir.'),
        ('Internet gerekli mi?', 'Ilk kurulum ve model indirme icin gerekli. Sonra cevrimdisi calisir.'),
        ('Hangi dilleri destekler?', 'Whisper 99 dil destekler. Turkce dahil.'),
        ('Pipeline ne kadar surer?', '39 dakikalik video icin yaklasik 15-25 dakika (GPU ile).'),
        ('Projemi nasil yedeklerim?', 'Admin Panel > Yedekleme > "Tam Yedek Al" butonuna basin.'),
    ]
    for q, a in faqs:
        story.append(Paragraph(f'<b>S: {q}</b>', ParagraphStyle('FAQ_Q', parent=body,
            textColor=BLUE, spaceBefore=8)))
        story.append(Paragraph(f'C: {a}', body))

    # ═══════════════════════════════════════════════
    # 8. SORUN GIDERME
    # ═══════════════════════════════════════════════
    story.append(PageBreak())
    story.append(Paragraph('8. Sorun Giderme', h1))
    story.append(HRFlowable(width='100%', thickness=1, color=BLUE))

    problems = [
        ('Python bulunamadi hatasi',
         'Python kurulumunda "Add to PATH" isaretlenmemis. Python i yeniden kurun ve bu secenegi isaretleyin. '
         'Veya bilgisayari yeniden baslatin.'),
        ('Sunucu baslamiyor (port 3000 kullaniliyor)',
         'Baska bir program 3000 portunu kullaniyor. Gorev Yoneticisi nden o programi kapatin '
         'veya .env dosyasinda PORT=3001 olarak degistirin.'),
        ('GPU kullanilmiyor (0%)',
         'NVIDIA suruculerini guncelleyin. CUDA 12+ gereklidir. '
         'PyTorch CUDA versiyonunun kurulu oldugundan emin olun.'),
        ('Pipeline takiliyor',
         'Buyuk dosyalarda bazi adimlar uzun surebilir. '
         'Admin Panel > Sunucu Loglari ndan durumu takip edin. '
         'Sorunlu adimi checkbox tan kapatip tekrar deneyin.'),
        ('Video ses/goruntu uyumsuz',
         'Bu bilinen bir sorundur. FFmpeg trim+concat filtresi kullanilmaktadir. '
         'Sorun devam ederse farkli bir video format deneyin.'),
        ('Turkce dosya adi hatasi',
         'Dosya adinda Turkce karakter varsa sorun olabilir. '
         'Dosya adini Ingilizce karakterlerle degistirip tekrar deneyin.'),
        ('Paketleri yeniden yuklemek istiyorum',
         'Kurulum klasorundeki .installed dosyasini silin ve Setup.bat i tekrar calistirin.'),
    ]
    for title, desc in problems:
        story.append(Paragraph(f'<b>{title}</b>', h3))
        story.append(Paragraph(desc, body))

    # ═══════════════════════════════════════════════
    # FOOTER
    # ═══════════════════════════════════════════════
    story.append(Spacer(1, 2*cm))
    story.append(HRFlowable(width='100%', thickness=1, color=GRAY))
    story.append(Spacer(1, 0.5*cm))
    story.append(Paragraph('Synergy Kendiyas Fabric v1.0.0 — AI Ses ve Video Editoru',
        ParagraphStyle('Footer', parent=body, fontSize=9, textColor=GRAY, alignment=TA_CENTER)))
    story.append(Paragraph('Nisan 2026',
        ParagraphStyle('Footer2', parent=body, fontSize=8, textColor=GRAY, alignment=TA_CENTER)))

    # Build
    doc.build(story)
    print(f'[OK] PDF olusturuldu: {OUTPUT}')
    print(f'     Boyut: {os.path.getsize(OUTPUT)/1024:.0f} KB')

if __name__ == '__main__':
    build()
