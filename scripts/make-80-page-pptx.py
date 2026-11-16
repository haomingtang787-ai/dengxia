from PIL import Image, ImageDraw, ImageFont
from pptx import Presentation
from pptx.util import Inches, Pt
import os, tempfile

out = os.path.join(tempfile.gettempdir(), 'desk-80-pages.pptx')
imgdir = os.path.join(tempfile.gettempdir(), 'desk-80-images')
os.makedirs(imgdir, exist_ok=True)

font_path = r'C:\Windows\Fonts\msyh.ttc'
font_big = ImageFont.truetype(font_path, 44)
font_mid = ImageFont.truetype(font_path, 30)
font_small = ImageFont.truetype(font_path, 24)

topics = [
    '光合作用的场所与证据', '叶绿体的结构', '光反应的条件', '光反应的能量转换',
    'ATP 与 NADPH 的角色', '暗反应的碳固定', '卡尔文循环', '光反应与暗反应的连接',
    '影响光合作用的因素', '光合作用与呼吸作用', '实验设计与变量控制', '图表题的读法',
]
points = [
    '叶绿体是绿色植物进行光合作用的主要场所。',
    '光反应在类囊体薄膜上进行，需要光、色素和酶。',
    '光反应把光能转成 ATP 和 NADPH 中的活跃化学能。',
    '暗反应在叶绿体基质中进行，不需要直接光照。',
    'CO2 在暗反应中被固定，最终进入糖类。',
    '光反应给暗反应提供 ATP 和 NADPH，暗反应给光反应提供 ADP 和 NADP+。',
    '温度、光照强度和 CO2 浓度都会影响光合作用速率。',
    '净光合速率等于总光合速率减去呼吸速率。',
    '实验要看自变量、因变量和无关变量，设置对照。',
    '曲线题先看横纵坐标，再看起点、拐点和平台期。',
]
visuals = [
    '光能 → 叶绿体 → ATP 与 NADPH',
    '类囊体薄膜上的色素吸收光',
    '光反应：H2O 分解，释放 O2',
    '暗反应：CO2 固定为有机物',
    '光反应与暗反应互相供料',
    '光照强度—光合速率曲线',
    'CO2 浓度—光合速率曲线',
    '温度—酶活性—光合速率',
    '净光合 = 总光合 − 呼吸',
    '实验组与对照组的变量控制',
]

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)
blank = prs.slide_layouts[6]

for i in range(80):
    chapter = i // 10 + 1
    topic = topics[i % len(topics)]
    visual = visuals[i % len(visuals)]
    # Generate the visual as an embedded image. The exact pixel text is what
    # the vision model must read.
    image_path = os.path.join(imgdir, f'slide-{i+1:03d}.png')
    image = Image.new('RGB', (1280, 520), '#ffffff')
    draw = ImageDraw.Draw(image)
    draw.rectangle([2, 2, 1277, 517], outline='#d1d5db', width=2)
    draw.text((40, 32), f'图 {i+1}：{visual}', font=font_big, fill='#111827')
    draw.ellipse([70, 160, 330, 420], outline='#2563eb', width=4)
    draw.text((125, 270), '叶绿体', font=font_mid, fill='#2563eb')
    draw.line([330, 290, 560, 290], fill='#dc2626', width=5)
    draw.text((390, 235), '光能', font=font_mid, fill='#dc2626')
    draw.rectangle([560, 145, 850, 435], outline='#059669', width=4)
    draw.text((600, 260), 'ATP / NADPH', font=font_mid, fill='#059669')
    draw.line([850, 290, 1060, 290], fill='#7c3aed', width=5)
    draw.text((900, 235), '暗反应', font=font_mid, fill='#7c3aed')
    draw.text((40, 455), f'第 {i+1} 页 · 第 {chapter} 章 · 知识点图', font=font_small, fill='#4b5563')
    image.save(image_path)

    slide = prs.slides.add_slide(blank)
    title = slide.shapes.add_textbox(Inches(0.55), Inches(0.35), Inches(12.2), Inches(0.9))
    tf = title.text_frame
    tf.text = f'第 {i+1} 页：{topic}'
    tf.paragraphs[0].font.size = Pt(30)
    tf.paragraphs[0].font.bold = True

    body = slide.shapes.add_textbox(Inches(0.65), Inches(1.35), Inches(5.4), Inches(2.2))
    btf = body.text_frame
    btf.word_wrap = True
    btf.text = f'第 {chapter} 章 · 核心知识'
    btf.paragraphs[0].font.size = Pt(16)
    btf.paragraphs[0].font.bold = True
    for j in range(2):
        p = btf.add_paragraph()
        p.text = f'• {points[(i + j) % len(points)]}'
        p.font.size = Pt(15)

    slide.shapes.add_picture(image_path, Inches(4.15), Inches(3.25), width=Inches(8.6), height=Inches(3.5))

prs.save(out)
print(out)
print(os.path.getsize(out))
