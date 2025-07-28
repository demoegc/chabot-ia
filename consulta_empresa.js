const axios = require("axios");
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { OpenAI } = require("openai");
const text = require('./utils/text.js');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const BITRIX24_API_URL = process.env.BITRIX24_API_URL;
const BITRIX24_HISTORIAL_FIELD = process.env.BITRIX24_HISTORIAL_FIELD || "UF_CRM_1752177274"

// Almacén de conversaciones por chatId
const conversationStore = new Map();

// Función para calcular similitud coseno
function similitudCoseno(a, b) {
    const dot = a.reduce((sum, ai, i) => sum + ai * b[i], 0);
    const magA = Math.sqrt(a.reduce((sum, ai) => sum + ai * ai, 0));
    const magB = Math.sqrt(b.reduce((sum, bi) => sum + bi * bi, 0));
    return dot / (magA * magB);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const vectorStore = JSON.parse(
    fs.readFileSync(path.join(__dirname, "docs", "vector_store_empresa.json"), "utf-8")
);

async function recuperarFragments(pregunta, topK = 3) {
    const embResponse = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: pregunta
    });
    const embPregunta = embResponse.data[0].embedding;

    const similitudes = vectorStore.map((item) => ({
        id_chunk: item.id_chunk,
        similitud: similitudCoseno(embPregunta, item.embedding),
        texto: item.texto
    }));

    similitudes.sort((a, b) => b.similitud - a.similitud);
    return similitudes.slice(0, topK);
}

async function generarMensajeSeguimiento(chatId) {
    try {
        // Obtener historial de conversación (local o de Bitrix24)
        let historial = '';
        let contactoExistente = '';

        // 1. Verificar historial local
        if (conversationStore.has(chatId)) {
            const conversacion = conversationStore.get(chatId);
            if (conversacion.history.length > 0) {
                historial = conversacion.history.map(interaccion => {
                    return `Cliente: ${interaccion.pregunta}\nAsistente: ${interaccion.respuesta}`;
                }).join('\n\n');
            }
        }

        // 2. Buscar historial en Bitrix24 si no hay suficiente contexto local
        contactoExistente = await checkContactHistory(chatId);
        if (!historial && contactoExistente) {
            historial = contactoExistente;
        }

        // 3. Si no hay historial en absoluto
        if (!historial) {
            const mensajeDefault = "Hola, ¿en qué puedo ayudarte hoy?";
            // Guardar en Bitrix24 incluso el mensaje por defecto
            await registrarSeguimientoEnBitrix(chatId, mensajeDefault, contactoExistente || '');
            return { respuesta: mensajeDefault };
        }

        // 4. Generar mensaje de seguimiento
        const prompt = `Basado en el siguiente historial de conversación, genera un mensaje de seguimiento amigable y natural para WhatsApp, preguntando si el cliente sigue interesado en el trámite o servicio mencionado anteriormente. El mensaje debe ser corto (1-2 líneas), cálido y profesional, sin signos de exclamación.

Historial de conversación:
${historial}

Mensaje de seguimiento:`;

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{
                role: "system",
                content: "Eres un asistente experto en redactar mensajes de seguimiento para clientes de inmigración. Usa un tono cálido y profesional, estilo WhatsApp."
            }, {
                role: "user",
                content: prompt
            }],
            temperature: 0.5
        });

        const mensajeSeguimiento = response.choices[0].message.content;

        // 5. Registrar el seguimiento en Bitrix24
        await registrarSeguimientoEnBitrix(chatId, mensajeSeguimiento, contactoExistente || '');

        // 6. Actualizar historial local si existe
        if (conversationStore.has(chatId)) {
            const conversacion = conversationStore.get(chatId);
            conversacion.history.push({
                pregunta: "[SISTEMA] Mensaje de seguimiento automático",
                respuesta: mensajeSeguimiento
            });
        }

        return { respuesta: mensajeSeguimiento };

    } catch (error) {
        console.error("Error al generar mensaje de seguimiento:", error.message);
        const mensajeError = "Hola, ¿sigues interesado en el trámite que hablamos anteriormente?";
        await registrarSeguimientoEnBitrix(chatId, mensajeError, '');
        return { respuesta: mensajeError };
    }
}


// Función auxiliar para registrar seguimientos en Bitrix24
async function registrarSeguimientoEnBitrix(chatId, mensaje, historialExistente) {
    try {
        // Buscar contacto en Bitrix24
        const response = await axios.get(`${BITRIX24_API_URL}crm.contact.list?FILTER[PHONE]=%2B${chatId}&SELECT[]=ID&SELECT[]=${BITRIX24_HISTORIAL_FIELD}`);

        if (response.data.result.length === 0) {
            console.log(`No se encontró contacto con número ${chatId} para registrar seguimiento`);
            return;
        }

        const contactId = response.data.result[0].ID;
        const now = new Date();
        const utcMinus4 = new Date(now.getTime() - (4 * 60 * 60 * 1000));
        const timestamp = `[${utcMinus4.toISOString().replace('T', ' ').substring(0, 19)}] `;

        // Formatear mensaje para el historial (sin emojis)
        const mensajeFormateado = mensaje.replace(/[\p{Emoji}\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '');
        const entradaHistorial = `${timestamp}Seguimiento automático:\n- Asistente: ${mensajeFormateado}\n\n`;

        // Actualizar el campo de historial
        const updateData = {
            [BITRIX24_HISTORIAL_FIELD]: historialExistente
                ? historialExistente + entradaHistorial
                : entradaHistorial
        };

        await axios.post(`${BITRIX24_API_URL}crm.contact.update`, {
            id: contactId,
            fields: updateData
        });

        console.log(`Seguimiento registrado para contacto ${contactId}`);
    } catch (error) {
        console.error("Error al registrar seguimiento en Bitrix24:", error.message);
    }
}

async function responderConPdf(preguntaUsuario, chatId) {
    // Inicializar o recuperar el historial de conversación
    if (!conversationStore.has(chatId)) {
        conversationStore.set(chatId, {
            history: [],
            isFirstMessage: true
        });
    }

    const conversacion = conversationStore.get(chatId);

    // Recuperar fragments relevantes
    const topFragments = await recuperarFragments(preguntaUsuario, 3);

    // Construir contexto con historial
    let contextoHistorial = "";
    if (conversacion.history.length > 0) {
        contextoHistorial = "Historial de esta conversación:\n";
        conversacion.history.forEach((interaccion, idx) => {
            contextoHistorial += `[Turno ${idx + 1}]\n`;
            contextoHistorial += `Cliente: ${interaccion.pregunta}\n`;
            contextoHistorial += `Tú: ${interaccion.respuesta}\n\n`;
        });
    }

    // Construir contexto con fragments
    let contextoDocumento = "Información relevante:\n";
    topFragments.forEach((fragmento, idx) => {
        contextoDocumento += `--- Fragmento ${idx + 1} ---\n${fragmento.texto}\n\n`;
    });

    // Verificar si existe un historial de conversación en Bitrix24
    const contactoExistente = await checkContactHistory(chatId);
    if (contactoExistente) {
        contextoHistorial = contactoExistente; // Usar el historial recuperado de Bitrix24
    }

    // Preparar mensajes para OpenAI con historial completo

    // console.log('contextoHistorial', contextoHistorial)
    const messages = [
        {
            role: "system",
            content: `Asistente virtual de WhatsApp del equipo de "Tu Agente de Inmigración". Tono: Cercano, humano, profesional pero natural. Puede usar pequeños errores ortográficos y abreviaciones comunes. Estilo: Mensajes cortos (1 a 2 líneas máx.), tipo chat humano.
Siempre que pregunte por un servicio, dile los presios y si gusta pagar para seguir con el proceso de desea.

${conversacion.isFirstMessage ? "" : "Ya no saludes"}

${text}

${contextoHistorial}
`
        },
        {
            role: "user",
            content: preguntaUsuario
        }
    ];

    // Generar respuesta
    const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages,
        temperature: 0.7
    });

    const respuesta = completion.choices[0].message.content;

    // Actualizar historial
    conversacion.history.push({
        pregunta: preguntaUsuario,
        respuesta: respuesta
    });

    // Actualizar el campo en Bitrix24 con el nuevo historial
    // await updateContactHistory(chatId, conversacion.history, contactoExistente || '');

    // Marcar que ya pasó el primer mensaje
    if (conversacion.isFirstMessage) {
        conversacion.isFirstMessage = false;
    }

    setTimeout(() => {
        conversationStore.delete(chatId);
    }, 500);

    return { respuesta, chatId, history: conversacion.history, contactoExistente: contactoExistente || '', preguntaUsuario };
}

// Función para verificar el historial en Bitrix24
async function checkContactHistory(chatId) {
    try {
        const response = await axios.get(`${BITRIX24_API_URL}crm.contact.list?FILTER[PHONE]=%2B${chatId}&SELECT[]=${BITRIX24_HISTORIAL_FIELD}`);
        if (response.data.result && response.data.result.length > 0) {
            return response.data.result[0][BITRIX24_HISTORIAL_FIELD] || ''; // Retorna el historial si existe
        }
    } catch (error) {
        console.error("Error al verificar el historial en Bitrix24:", error.message);
    }
    return '';
}

// Función para actualizar el historial en Bitrix24
async function updateContactHistory(chatId, history, contactoExistente) {
    try {
        // Buscar el contacto en Bitrix24 usando el número de teléfono (chatId)
        const response = await axios.get(`${BITRIX24_API_URL}crm.contact.list?FILTER[PHONE]=%2B${chatId}&SELECT[]=ID&SELECT[]=${BITRIX24_HISTORIAL_FIELD}`);

        if (response.data.result.length === 0) {
            console.log(`No se encontró contacto con el número ${chatId}`);
            return; // Si no se encuentra el contacto, terminamos la función
        }

        // Obtener el ID del contacto
        const contactId = response.data.result[0].ID;

        // Crear el historial a partir de las interacciones y eliminar los emojis
        const historial = history.map(interaccion => {
            let pregunta = interaccion.pregunta.replace(/[\p{Emoji}\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '');
            let respuesta = interaccion.respuesta.replace(/[\p{Emoji}\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '');
            return `- Cliente: ${pregunta}\n- Asistente IA: ${respuesta}\n\n`;
        });

        // Obtener la hora actual en UTC-4
        const now = new Date();
        const utcMinus4 = new Date(now.getTime() - (4 * 60 * 60 * 1000));
        const horaInicio = `Hora de inicio de la conversación: ${utcMinus4.toISOString().replace('T', ' ').substring(0, 19)}\n\n`;

        // Datos que se actualizarán en Bitrix24
        let updateData;
        if (!contactoExistente || contactoExistente.length === 0) {
            // Si no hay historial existente, agregamos la hora de inicio
            updateData = {
                [BITRIX24_HISTORIAL_FIELD]: horaInicio + historial.join('')
            };
        } else {
            // Si ya hay historial, solo agregamos la nueva interacción
            updateData = {
                [BITRIX24_HISTORIAL_FIELD]: contactoExistente + historial[historial.length - 1]
            };
        }

        // Actualizar el contacto en Bitrix24 con el nuevo historial
        const updateResponse = await axios.post(`${BITRIX24_API_URL}crm.contact.update`, {
            id: contactId,
            fields: updateData
        });

        console.log(`Historial actualizado correctamente en el contacto con ID: ${contactId}`);
    } catch (error) {
        console.error("Error al actualizar el historial en Bitrix24:", error.message);
    }
}



// Limpiar conversaciones antiguas periódicamente (si aún es necesario)
function limpiarConversacionesInactivas() {
    const ahora = Date.now();
    const UMBRAL_INACTIVIDAD = 30 * 60 * 1000; // 30 minutos

    conversationStore.forEach((conversacion, chatId) => {
        if (ahora - conversacion.ultimaInteraccion > UMBRAL_INACTIVIDAD) {
            conversationStore.delete(chatId);
        }
    });
}

// Función para obtener resumen completo del historial de conversación
async function obtenerResumenHistorial(chatId) {
    try {
        // Obtener historial local y de Bitrix24 (igual que antes)
        const conversacionLocal = conversationStore.get(chatId);
        let historialCompleto = '';
        
        if (conversacionLocal && conversacionLocal.history.length > 0) {
            historialCompleto = conversacionLocal.history.map(interaccion => {
                return `Cliente: ${interaccion.pregunta}\nAsistente: ${interaccion.respuesta}`;
            }).join('\n\n');
        }

        // Obtener historial de Bitrix24
        const historialBitrix = await checkContactHistory(chatId);
        if (historialBitrix && historialBitrix.length > 0) {
            historialCompleto += (historialCompleto ? '\n\n' : '') + historialBitrix;
        }

        if (!historialCompleto) {
            return "No hay historial de conversación con este cliente.";
        }

        // Enviar a OpenAI para resumen
        const prompt = `Resume la siguiente conversación de WhatsApp con un cliente de inmigración, destacando:
1. Nombre y apellido
2. Número de Whatsapp: +${chatId}
3. Trámites mencionados
4. Nivel de interés
6. Estado migratorio
7. Canal de entrada: (Meta Ads)
8. Dudas pendientes
9. Fecha y hora de inicio de la conversación

Conversación:
${historialCompleto}

Resumen profesional:`;

        const resumenResponse = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{
                role: "system",
                content: "Eres un asistente experto en resumir conversaciones de inmigración. Proporciona un resumen claro y conciso."
            }, {
                role: "user",
                content: prompt
            }],
            temperature: 0.3
        });

        return resumenResponse.choices[0].message.content;

    } catch (error) {
        console.error("Error al obtener resumen del historial:", error.message);
        return "Error al generar el resumen de la conversación.";
    }
}

module.exports = {
    responderConPdf,
    limpiarConversacionesInactivas,
    obtenerResumenHistorial,
    generarMensajeSeguimiento,
    updateContactHistory
};