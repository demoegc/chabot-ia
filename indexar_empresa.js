require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { OpenAI } = require("openai");

// Inicializa OpenAI con tu API key
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Ruta al JSON con los chunks
const rutaChunks = path.join(__dirname, "docs", "chunks_empresa.json");

// Vector store local: será un arreglo de objetos con { id_chunk, embedding, texto }
const vectorStore = [];

async function indexar() {
  // 1. Carga los fragments
  const chunks = JSON.parse(fs.readFileSync(rutaChunks, "utf-8"));

  for (let i = 0; i < chunks.length; i++) {
    const textoChunk = chunks[i];

    // 2. Pide el embedding a OpenAI
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: textoChunk
    });

    const emb = embeddingResponse.data[0].embedding; // array de floats

    // 3. Guarda en el vectorStore
    vectorStore.push({
      id_chunk: `chunk-${i}`,
      embedding: emb,
      texto: textoChunk
    });

    // Solo opcional: muestra progreso en consola cada 50 chunks
    if (i > 0 && i % 50 === 0) {
      console.log(`Indexados ${i} de ${chunks.length} fragments...`);
    }
  }

  // 4. Guardamos el vectorStore en un JSON local (puede reemplazarse por Pinecone, etc.)
  fs.writeFileSync(
    path.join(__dirname, "docs", "vector_store_empresa.json"),
    JSON.stringify(vectorStore, null, 2),
    "utf-8"
  );
  console.log("Indexación completada. Total de embeddings:", vectorStore.length);
}

indexar().catch(console.error);
