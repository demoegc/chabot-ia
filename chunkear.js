const fs = require("fs");
const path = require("path");

// Función que corta un string en trozos de X caracteres (sin partir en medio de una palabra)
function dividirEnChunks(texto, maxChars = 1000) {
  const chunks = [];
  let inicio = 0;

  while (inicio < texto.length) {
    // Busca el índice más cercano a maxChars que sea un salto de línea o espacio
    let fin = inicio + maxChars;
    if (fin >= texto.length) fin = texto.length;
    else {
      // retrocede hasta encontrar un espacio o salto de línea para no cortar palabras a la fuerza
      while (fin > inicio && !/\s/.test(texto[fin])) {
        fin--;
      }
      if (fin === inicio) fin = inicio + maxChars; // si no hay espacio, corta exactamente en maxChars
    }

    const chunk = texto.slice(inicio, fin).trim();
    chunks.push(chunk);
    inicio = fin;
  }

  return chunks;
}

// Prueba local
const textoCompleto = fs.readFileSync(path.join(__dirname, "docs", "empresa.txt"), "utf-8");
const fragments = dividirEnChunks(textoCompleto, 1000);
console.log("Total de fragments generados:", fragments.length);

// (Opcional) guarda los fragments en un JSON para revisarlos
fs.writeFileSync(
  path.join(__dirname, "docs", "chunks_empresa.json"),
  JSON.stringify(fragments, null, 2),
  "utf-8"
);
