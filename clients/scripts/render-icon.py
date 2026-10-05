"""生成与共享 SVG 相同图形的 Windows ICO 与预览 PNG（需要 Pillow）。"""
from pathlib import Path
from PIL import Image, ImageDraw
out = Path(__file__).resolve().parents[1] / 'shared'
im = Image.new('RGBA', (256, 256))
d = ImageDraw.Draw(im)
d.rounded_rectangle((0, 0, 255, 255), radius=52, fill='#0f233e')
d.ellipse((158,39,210,91), fill='#facc15')
d.polygon([(38,86),(166,86),(150,168),(22,168)], fill='#22b9e8')
d.line([(38,86),(166,86),(150,168),(22,168),(38,86)], fill='#e0f2fe', width=6)
for line in [[(76,87),(60,167)],[(117,87),(101,167)],[(33,113),(160,113)],[(28,141),(155,141)]]:
    d.line(line, fill='#0f233e', width=5)
d.rounded_rectangle((112,158,235,216), radius=13, fill='#e0f2fe')
for y in [179,197]: d.line((127,y,219,y), fill='#0f233e', width=6)
d.line((54,185,54,208), fill='#e0f2fe', width=7)
d.line((37,208,75,208), fill='#e0f2fe', width=7)
im.save(out / 'icon.png')
im.save(out / 'app.ico', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
