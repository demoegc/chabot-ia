// extraer_pdf.js
const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const { PdfReader } = require("pdfreader");

// 1. Obtén la ruta al PDF desde la línea de comandos
const rutaPdf = 'empresa.pdf' || process.argv[2];
if (!rutaPdf) {
  console.error('Uso: node extraer_pdf.js <ruta-al-pdf>');
  process.exit(1);
}

// 2. Resuelve la ruta absoluta y comprueba que existe
const rutaAbsoluta = path.resolve(rutaPdf);
if (!fs.existsSync(rutaAbsoluta)) {
  console.error(`Error: no existe el archivo:\n  ${rutaAbsoluta}`);
  process.exit(1);
}

// 3. Función para extraer el texto
async function extraerTextoPdf(ruta) {
  return new Promise((resolve, reject) => {
    let text = "";
    new PdfReader().parseFileItems(ruta, (err, item) => {
      if (err) reject(err);
      else if (!item) resolve(text);
      else if (item.text) text += item.text + " ";
    });
  });
}

// 4. Ejecución principal
(async () => {
  try {
    const textoCompleto = await extraerTextoPdf(rutaAbsoluta);

    // Carpeta donde está el PDF
    const carpetaPdf = path.dirname(rutaAbsoluta);
    // Archivo de salida: empresa.txt en esa misma carpeta
    const rutaSalida = path.join(carpetaPdf, "docs", 'empresa.txt');

    fs.writeFileSync(rutaSalida, textoCompleto, 'utf-8');
    console.log(`Extracción concluida. Texto guardado en:\n  ${rutaSalida}`);
  } catch (error) {
    console.error('Error extrayendo PDF:', error);
    process.exit(1);
  }
})();
