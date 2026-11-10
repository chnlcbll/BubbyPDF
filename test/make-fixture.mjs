// Builds test/fixture.pdf: 3 pages, real text, an AcroForm (text, checkbox, radio, dropdown),
// an internal link from page 1 to page 3, and page 2 stored with /Rotate 90.
import { PDFDocument, StandardFonts, rgb, degrees, PDFName, PDFArray, PDFNumber } from 'pdf-lib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const form = doc.getForm();

const p1 = doc.addPage([612, 792]);
p1.drawText('BubbyPDF test form', { x: 72, y: 720, size: 22, font });
p1.drawText('Invoice number 4471 for blue widgets.', { x: 72, y: 690, size: 12, font });
p1.drawText('Name', { x: 72, y: 640, size: 11, font });
form.createTextField('name').addToPage(p1, { x: 140, y: 632, width: 220, height: 22 });
p1.drawText('Agree', { x: 72, y: 600, size: 11, font });
form.createCheckBox('agree').addToPage(p1, { x: 140, y: 596, width: 16, height: 16 });
p1.drawText('Size', { x: 72, y: 560, size: 11, font });
const rg = form.createRadioGroup('size');
rg.addOptionToPage('small', p1, { x: 140, y: 556, width: 14, height: 14 });
rg.addOptionToPage('large', p1, { x: 200, y: 556, width: 14, height: 14 });
p1.drawText('Color', { x: 72, y: 520, size: 11, font });
const dd = form.createDropdown('color');
dd.addOptions(['red', 'green', 'blue']);
dd.addToPage(p1, { x: 140, y: 514, width: 120, height: 20 });
p1.drawText('Go to the last page', { x: 72, y: 470, size: 12, font, color: rgb(0.1, 0.3, 0.8) });

// A three-line paragraph in Times for paragraph editing tests.
const times = await doc.embedFont(StandardFonts.TimesRoman);
['Our zephyr crate holds eleven brass hinges and', 'four spare latches, packed in straw to keep them', 'quiet during the long trip north.']
  .forEach((t, i) => p1.drawText(t, { x: 72, y: 410 - i * 14, size: 11, font: times }));

const p2 = doc.addPage([612, 792]);
p2.drawText('Second page, stored rotated by 90 degrees.', { x: 72, y: 700, size: 14, font });
p2.setRotation(degrees(90));

const p3 = doc.addPage([612, 792]);
p3.drawText('Third page. The widgets ship on Tuesday.', { x: 72, y: 700, size: 14, font });

// Internal link on page 1 -> page 3
const link = doc.context.obj({
  Type: 'Annot', Subtype: 'Link', Rect: [72, 465, 190, 482], Border: [0, 0, 0],
  Dest: [p3.ref, PDFName.of('XYZ'), PDFNumber.of(0), PDFNumber.of(792), PDFNumber.of(0)],
});
const annots = p1.node.lookup(PDFName.of('Annots'), PDFArray);
annots.push(doc.context.register(link));

const out = fileURLToPath(new URL('./fixture.pdf', import.meta.url));
writeFileSync(out, await doc.save());
console.log('wrote', out);
