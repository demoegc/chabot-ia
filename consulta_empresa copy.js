const axios = require("axios");
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { OpenAI } = require("openai");
const text = require('./utils/text.js');
const moment = require('moment-timezone');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const BITRIX24_API_URL = process.env.BITRIX24_API_URL;
// const BITRIX24_HISTORIAL_FIELD = process.env.BITRIX24_HISTORIAL_FIELD || "UF_CRM_1752177274"
const BITRIX24_HISTORIAL_FIELD = "UF_CRM_1752177274"

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
        let { historial: hist, resumenHistorial } = await checkContactHistory(chatId, obtenerResumen = true);
        contactoExistente = hist;
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
        const prompt = `Basado en el siguiente historial de conversación, genera un mensaje de seguimiento.
Quiero que actúes como un redactor de mensajes de seguimiento para un chatbot de WhatsApp especializado en trámites migratorios (asilo, permiso de trabajo y petición familiar). El objetivo es contactar prospectos que mostraron interés pero no han avanzado. Los mensajes deben:
1.    Tener un tono humano, cálido, cercano y empático.
2.    Evitar que parezcan persecución o presión directa.
3.    Incluir beneficios claros y atractivos del trámite específico.
4.    Generar la sensación de que la persona podría perder una oportunidad importante si no avanza.
5.    Terminar con una pregunta abierta que invite a la respuesta sin forzarla.
6.    Usar lenguaje sencillo y frases cortas para WhatsApp.
7.    Evitar expresiones legales o que den la impresión de asesoría jurídica.
8.    En el caso de petición familiar, si el cliente está casado con un(a) ciudadano(a) estadounidense, el mensaje debe personalizarse con base en esa información.
9.    Si tienes el nombre del cliente, siempre llámalo por su primer nombre en el saludo.

Por favor, genera tres ejemplos distintos de mensajes para cada trámite, siguiendo estas reglas:
ASILO

1. Hola [Nombre] 😊 Quería contarte que varias personas que iniciaron su solicitud de asilo hace poco ya tienen su permiso de trabajo y están encontrando empleos estables. Es una gran oportunidad para empezar a construir seguridad aquí en EE.UU. ¿Quieres que te explique cómo podrías iniciar hoy?

2. ¡Hola [Nombre]! 👋 Muchas personas que presentaron su asilo ya están trabajando legalmente mientras esperan la decisión. Así han podido mejorar sus ingresos y estabilidad. No quisiera que te quedaras fuera de esa posibilidad. ¿Quieres que te cuente cómo lograrlo?

3. Hola [Nombre] 😊 Me alegra ver que cada vez más personas que solicitan asilo logran obtener su permiso de trabajo y avanzar en sus metas aquí en EE.UU. A veces, dar ese primer paso hace toda la diferencia. ¿Quieres que retomemos tu caso?

⸻

PERMISO DE TRABAJO

1. ¡Hola [Nombre]! 👋 Con tu permiso de trabajo vigente podrías aplicar a mejores empleos, con más ingresos y beneficios. Muchos de nuestros clientes que lo renovaron ya están aprovechando nuevas oportunidades. ¿Quieres que te guíe para que no pierdas esa ventaja?

2. Hola [Nombre] 😊 Tener el permiso de trabajo al día puede abrirte la puerta a empleos mejor pagados y con más estabilidad. Sería una pena que se venciera y frenar tus planes. ¿Quieres que te explique cómo renovarlo a tiempo?

3. ¡Hola [Nombre]! 😃 Recuerda que con tu permiso vigente puedes trabajar legalmente, crecer profesionalmente y acceder a beneficios que sin él no tendrías. Si lo dejamos vencer, puede complicar tu situación. ¿Te cuento cómo evitarlo?

⸻

PETICIÓN FAMILIAR

(Versión para cliente casado/a con ciudadano/a estadounidense)

1. Hola [Nombre] 😊 Recuerdo que me comentaste que estás casado(a) con un(a) ciudadano(a) estadounidense. Este es un buen momento para iniciar la petición, ya que el proceso suele ser más rápido y podrías obtener tu residencia antes de lo que imaginas. ¿Quieres que retomemos lo que hablamos y avancemos con tu caso?

2. ¡Hola [Nombre]! 👋 Como estás casado(a) con un(a) ciudadano(a) de EE.UU., tu trámite de residencia puede avanzar más rápido que en otros casos. Muchas parejas ya están disfrutando de este beneficio. ¿Quieres que te explique los pasos para que no pierdas tiempo?

3. Hola [Nombre] 😊 Por tu matrimonio con un(a) ciudadano(a) estadounidense, tienes la ventaja de que el proceso para la residencia es más ágil. Entre más pronto lo iniciemos, más pronto podrás disfrutar de la estabilidad que trae. ¿Quieres que retomemos tu solicitud?

Historial de conversación:
${historial}


${resumenHistorial
                ? 'Resumen de la conversación:\n' + resumenHistorial
                : ''
            }

No repitas siempre los mismo cada vez que se haga un seguimiento, para que parezca más natural el seguimiento

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
        // 1. Primero buscar en Leads
        const leadResponse = await axios.get(
            `${BITRIX24_API_URL}crm.lead.list?FILTER[PHONE]=%2B${chatId}&SELECT[]=ID&SELECT[]=CONTACT_ID&SELECT[]=${BITRIX24_HISTORIAL_FIELD}`
        );

        let entityId, isContact = false, entityType = 'lead';
        let existingHistory = historialExistente || '';

        // Si encontramos leads
        if (leadResponse.data.result && leadResponse.data.result.length > 0) {
            const lead = leadResponse.data.result[leadResponse.data.result.length - 1];
            entityId = lead.ID;
            existingHistory = lead[BITRIX24_HISTORIAL_FIELD] || existingHistory;

            // Si el lead tiene contacto asociado, usaremos el contacto
            if (lead.CONTACT_ID && lead.CONTACT_ID !== '0') {
                const contactResponse = await axios.get(
                    `${BITRIX24_API_URL}crm.contact.get?id=${lead.CONTACT_ID}&SELECT[]=${BITRIX24_HISTORIAL_FIELD}`
                );

                if (contactResponse.data.result) {
                    entityId = contactResponse.data.result.ID;
                    existingHistory = contactResponse.data.result[BITRIX24_HISTORIAL_FIELD] || existingHistory;
                    isContact = true;
                    entityType = 'contact';
                }
            }
        } else {
            // 2. Si no hay leads, buscar directamente en contactos
            // const contactResponse = await axios.get(
            //     `${BITRIX24_API_URL}crm.contact.list?FILTER[PHONE]=%2B${chatId}&SELECT[]=ID&SELECT[]=${BITRIX24_HISTORIAL_FIELD}`
            // );

            // if (!contactResponse.data.result || contactResponse.data.result.length === 0) {
            //     console.log(`No se encontró lead ni contacto con número ${chatId} para registrar seguimiento`);
            //     return;
            // }

            // entityId = contactResponse.data.result[0].ID;
            // existingHistory = contactResponse.data.result[0][BITRIX24_HISTORIAL_FIELD] || existingHistory;
            // isContact = true;
            // entityType = 'contact';
        }

        // Preparar el mensaje de seguimiento
        const now = new Date();
        const utcMinus4 = new Date(now.getTime() - (4 * 60 * 60 * 1000));
        const timestamp = `[${utcMinus4.toISOString().replace('T', ' ').substring(0, 19)}] `;

        const mensajeFormateado = mensaje.replace(/[\p{Emoji}\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '');
        const entradaHistorial = `${timestamp}Seguimiento automático:\n- Asistente: ${mensajeFormateado}\n\n`;

        // Actualizar el historial
        const updateData = {
            [BITRIX24_HISTORIAL_FIELD]: existingHistory
                ? existingHistory + entradaHistorial
                : entradaHistorial
        };

        // Determinar el endpoint según si es contacto o lead
        const updateEndpoint = isContact
            ? `${BITRIX24_API_URL}crm.contact.update`
            : `${BITRIX24_API_URL}crm.lead.update`;

        await axios.post(updateEndpoint, {
            id: entityId,
            fields: updateData
        });

        console.log(`Seguimiento registrado en ${entityType} ${entityId}`);
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

    // Hora actual en UTC-4
    const dateInTimeZone = moment.tz("America/Caracas").format();

    // console.log('contextoHistorial', contextoHistorial)
    const messages = [
        {
            role: "system",
            content: `Hora actual ${dateInTimeZone}\n
Asistente virtual de WhatsApp del equipo de "Tu Agente de Inmigración". Tono: Cercano, humano, profesional pero natural. Puede usar pequeños errores ortográficos y abreviaciones comunes. Estilo: Mensajes cortos (1 a 2 líneas máx.), tipo chat humano.
Siempre que pregunte por un servicio, dile los presios y si gusta pagar para seguir con el proceso de desea.

${conversacion.isFirstMessage ? "" : "Ya no saludes"}

${text}

${contextoHistorial}

${contextoHistorial !== '' ? 'Estudia el historial y responde en base a lo que ya se ha hablado con el cliente' : ''}
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

    // Verificar si la respuesta indica una transferencia a agente
    const transferenciaDetectada = await verificarTransferenciaAgente(chatId, respuesta, conversacion.history);
    console.log('transferenciaDetectada', transferenciaDetectada)

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

// Función para verificar si la respuesta indica transferencia a agente
async function verificarTransferenciaAgente(chatId, ultimaRespuesta, historialConversacion) {
    try {
        const prompt = `Analiza el siguiente mensaje y determina si indica que el cliente será transferido a un agente humano. 
Responde solo con "SI" o "NO".

Mensaje a analizar:
"${ultimaRespuesta}"

Contexto de conversación:
${historialConversacion.map(i => `${i.pregunta}\n${i.respuesta}`).join('\n\n')}`;

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{
                role: "system",
                content: 'Eres un asistente que solo responde con SI o NO, indicando si el mensaje significa que el cliente será transferido a un agente humano. Cuando el mensaje a analizar diga que va a ser transferido con un agente afirmativamente, puedes decir "SI". Si lo hace en forma de pregunta como: "puedo agendarte con un asesor experto para avanzar con este paso. ¿Te gustaría que lo haga ahora?" tienes que responder "NO"'
            }, {
                role: "user",
                content: prompt
            }],
            temperature: 0,
            max_tokens: 2
        });

        return response.choices[0].message.content.trim().toUpperCase() === "SI";
    } catch (error) {
        console.error("Error al verificar transferencia a agente:", error);
        return false;
    }
}

// Función para notificar a Bitrix24 sobre la transferencia
async function notificarTransferenciaAgente(chatId, mensajeTransferencia) {
    try {
        // 1. Obtener información del contacto/lead
        const leadResponse = await axios.get(
            `${BITRIX24_API_URL}crm.lead.list?FILTER[PHONE]=%2B${chatId}&SELECT[]=ID&SELECT[]=CONTACT_ID&SELECT[]=ASSIGNED_BY_ID`
        );

        let entityId, isContact = false, assignedTo;

        if (leadResponse.data.result && leadResponse.data.result.length > 0) {
            const lead = leadResponse.data.result[leadResponse.data.result.length - 1];
            entityId = lead.ID;
            assignedTo = lead.ASSIGNED_BY_ID;

            if (lead.CONTACT_ID && lead.CONTACT_ID !== '0') {
                const contactResponse = await axios.get(
                    `${BITRIX24_API_URL}crm.contact.get?id=${lead.CONTACT_ID}&SELECT[]=ASSIGNED_BY_ID`
                );

                if (contactResponse.data.result) {
                    entityId = contactResponse.data.result.ID;
                    assignedTo = contactResponse.data.result.ASSIGNED_BY_ID;
                    isContact = true;
                }
            }
        }

        if (!assignedTo) {
            console.log("No se encontró agente asignado para notificar");
            return;
        }

        // 2. Crear notificación en Bitrix24
        const notificationText = `El cliente con número ${chatId} ha sido transferido al agente. 
Mensaje de transferencia: ${mensajeTransferencia.replace(/[\p{Emoji}\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')}`;

        await axios.post(`${BITRIX24_API_URL}im.notify`, {
            to: assignedTo,
            message: notificationText,
            type: "SYSTEM"
        });

        console.log(`Notificación de transferencia enviada al agente ${assignedTo}`);
    } catch (error) {
        console.error("Error al notificar transferencia a agente:", error.message);
    }
}

// Función para verificar el historial en Bitrix24
async function checkContactHistory(chatId, obtenerResumen) {
    try {
        // 1. Primero buscar en Leads
        const leadResponse = await axios.get(
            `${BITRIX24_API_URL}crm.lead.list?FILTER[PHONE]=%2B${chatId}&SELECT[]=ID&SELECT[]=CONTACT_ID&SELECT[]=${BITRIX24_HISTORIAL_FIELD}&SELECT[]=UF_CRM_1754666415`
        );

        // Si encontramos leads, verificar el historial
        if (leadResponse.data.result && leadResponse.data.result.length > 0) {
            const lead = leadResponse.data.result[leadResponse.data.result.length - 1];

            // Si el lead tiene contacto asociado, obtener el historial del contacto
            if (lead.CONTACT_ID && lead.CONTACT_ID !== '0') {
                const contactResponse = await axios.get(
                    `${BITRIX24_API_URL}crm.contact.get?id=${lead.CONTACT_ID}&SELECT[]=${BITRIX24_HISTORIAL_FIELD}&SELECT[]=UF_CRM_1754666415`
                );

                if (contactResponse.data.result) {
                    if (obtenerResumen) {
                        return {
                            historial: contactResponse.data.result[BITRIX24_HISTORIAL_FIELD] || '',
                            resumenHistorial: contactResponse.data.result['UF_CRM_1754666415'] || '',
                            entityType: 'contact'
                        };
                    }
                    return contactResponse.data.result[BITRIX24_HISTORIAL_FIELD] || '';
                }
            }

            // Si no tiene contacto o no se pudo obtener, devolver datos del lead
            if (obtenerResumen) {
                return {
                    historial: lead[BITRIX24_HISTORIAL_FIELD] || '',
                    resumenHistorial: lead['UF_CRM_1754666415'] || '',
                    entityType: 'lead'
                };
            }
            return lead[BITRIX24_HISTORIAL_FIELD] || '';
        }

        // 2. Si no encontramos leads, buscar directamente en contactos
        // const contactResponse = await axios.get(
        //     `${BITRIX24_API_URL}crm.contact.list?FILTER[PHONE]=%2B${chatId}&SELECT[]=${BITRIX24_HISTORIAL_FIELD}&SELECT[]=UF_CRM_1754666415`
        // );

        // if (contactResponse.data.result && contactResponse.data.result.length > 0) {
        //     if (obtenerResumen) {
        //         return { 
        //             historial: contactResponse.data.result[0][BITRIX24_HISTORIAL_FIELD] || '',
        //             resumenHistorial: contactResponse.data.result[0]['UF_CRM_1754666415'] || '',
        //             entityType: 'contact'
        //         };
        //     }
        //     return contactResponse.data.result[0][BITRIX24_HISTORIAL_FIELD] || '';
        // }

    } catch (error) {
        console.error("Error al verificar el historial en Bitrix24:", error.message);
    }

    // Retorno por defecto
    if (obtenerResumen) {
        return { historial: '', resumenHistorial: '', entityType: null };
    }
    return '';
}

// Función para actualizar el historial en Bitrix24
async function updateContactHistory(chatId, history, historialExistente) {
    try {
        // Primero buscar el Lead que contenga este número de teléfono
        const leadResponse = await axios.get(`${BITRIX24_API_URL}crm.lead.list?FILTER[PHONE]=%2B${chatId}&SELECT[]=ID&SELECT[]=CONTACT_ID&SELECT[]=${BITRIX24_HISTORIAL_FIELD}`);

        let entityId, leadId, isContact = false, entityType = 'lead';
        let existingHistory = '';

        if (leadResponse.data.result.length > 0) {
            const lead = leadResponse.data.result[leadResponse.data.result.length - 1];
            entityId = lead.ID;
            leadId = lead.ID;
            existingHistory = lead[BITRIX24_HISTORIAL_FIELD] || '';

            // Si el Lead tiene contacto asociado, usaremos el contacto en lugar del lead
            if (lead.CONTACT_ID && lead.CONTACT_ID !== '0') {
                const contactResponse = await axios.get(`${BITRIX24_API_URL}crm.contact.get?id=${lead.CONTACT_ID}&SELECT[]=ID&SELECT[]=${BITRIX24_HISTORIAL_FIELD}`);
                if (contactResponse.data.result) {
                    entityId = contactResponse.data.result.ID;
                    existingHistory = contactResponse.data.result[BITRIX24_HISTORIAL_FIELD] || '';
                    isContact = true;
                    entityType = 'contact';
                }
            }
        } else {
            // Si no hay lead, buscar directamente en contactos
            const contactResponse = await axios.get(`${BITRIX24_API_URL}crm.contact.list?FILTER[PHONE]=%2B${chatId}&SELECT[]=ID&SELECT[]=${BITRIX24_HISTORIAL_FIELD}`);

            if (contactResponse.data.result.length === 0) {
                console.log(`No se encontró lead ni contacto con el número ${chatId}`);
                return;
            }

            entityId = contactResponse.data.result[0].ID;
            existingHistory = contactResponse.data.result[0][BITRIX24_HISTORIAL_FIELD] || '';
            isContact = true;
            entityType = 'contact';
        }

        // Crear el historial a partir de las interacciones y eliminar los emojis
        const historial = history.map(interaccion => {
            const now = new Date();
            const utcMinus4 = new Date(now.getTime() - (4 * 60 * 60 * 1000));
            const timestamp = `[${utcMinus4.toISOString().replace('T', ' ').substring(0, 19)}]\n`;

            let pregunta = interaccion.pregunta.replace(/[\p{Emoji}\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '');
            let respuesta = interaccion.respuesta.replace(/[\p{Emoji}\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '');

            return `${timestamp}- Cliente: ${pregunta}\n- Asistente IA: ${respuesta}\n\n`;
        });

        // Obtener la hora actual en UTC-4 para el inicio de conversación
        const now = new Date();
        const utcMinus4 = new Date(now.getTime() - (4 * 60 * 60 * 1000));
        const horaInicio = `Hora de inicio de la conversación: ${utcMinus4.toISOString().replace('T', ' ').substring(0, 19)}\n\n`;

        // Datos que se actualizarán en Bitrix24
        let updateData;
        if (!historialExistente || historialExistente.length === 0) {
            // Si no hay historial existente, agregamos la hora de inicio
            updateData = {
                [BITRIX24_HISTORIAL_FIELD]: horaInicio + historial.join('')
            };
        } else {
            // Si ya hay historial, solo agregamos la nueva interacción con timestamp
            updateData = {
                [BITRIX24_HISTORIAL_FIELD]: existingHistory + historial[historial.length - 1]
            };
        }

        let resumenHistorial = await obtenerResumenHistorial(chatId, updateData[BITRIX24_HISTORIAL_FIELD]);

        // Actualizar la entidad (lead o contacto) en Bitrix24 con el nuevo historial
        const updateEndpoint = isContact
            ? `${BITRIX24_API_URL}crm.contact.update`
            : `${BITRIX24_API_URL}crm.lead.update`;

        await axios.post(updateEndpoint, {
            id: entityId,
            fields: updateData
        });

        // Guardar el resumen en la entidad correspondiente
        await guardarResumenHistorial(entityId, resumenHistorial, isContact);

        // Lógica para iniciar el workflow si es un lead con estado específico
        if (leadId) {
            const leadStatusResponse = await axios.get(`${BITRIX24_API_URL}crm.lead.get?id=${leadId}&SELECT[]=STATUS_ID`);
            if (leadStatusResponse.data.result.STATUS_ID === "UC_61ZU35") {
                await axios.post(`${BITRIX24_API_URL}bizproc.workflow.start`, {
                    TEMPLATE_ID: 767,
                    DOCUMENT_ID: [
                        'crm',
                        'CCrmDocumentLead',
                        `LEAD_${leadId}`
                    ],
                });
            }
        }

        console.log(`Historial actualizado correctamente en el ${entityType} con ID: ${entityId}`);
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
async function obtenerResumenHistorial(chatId, historial) {
    try {

        let historialCompleto = '';

        if (!historial) {

            // Obtener historial local y de Bitrix24 (igual que antes)
            const conversacionLocal = conversationStore.get(chatId);

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
        }
        else {
            historialCompleto = historial
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

const guardarResumenHistorial = async (entityId, resumenHistorial, isContact = true) => {
    try {
        // Definir los campos específicos para cada tipo de entidad
        const contactField = 'UF_CRM_1754666415'; // Campo de resumen para Contactos
        const leadField = 'UF_CRM_1754666415';   // Campo de resumen para Leads (ajusta este ID)

        const endpoint = isContact
            ? `${BITRIX24_API_URL}crm.contact.update`
            : `${BITRIX24_API_URL}crm.lead.update`;

        const fieldToUpdate = isContact ? contactField : leadField;

        await axios.post(endpoint, {
            id: entityId,
            fields: {
                [fieldToUpdate]: resumenHistorial
            }
        });

        console.log(`Resumen guardado correctamente en el ${isContact ? 'contacto' : 'lead'} con ID: ${entityId}`);
    } catch (error) {
        console.error(`Error al guardar el resumen en ${isContact ? 'contacto' : 'lead'}:`, error.message);
    }
}

module.exports = {
    responderConPdf,
    limpiarConversacionesInactivas,
    obtenerResumenHistorial,
    generarMensajeSeguimiento,
    updateContactHistory,
    guardarResumenHistorial
};