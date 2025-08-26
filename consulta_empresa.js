const axios = require("axios");
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { OpenAI } = require("openai");
const text = require('./utils/text.js');
const moment = require('moment-timezone');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const BITRIX24_API_URL = process.env.BITRIX24_API_URL;
const BITRIX24_HISTORIAL_FIELD = "UF_CRM_1752177274"

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

async function generarMensajeSeguimiento(chatId, trackingNumber) {
    try {
        // Obtener historial directamente de Bitrix24
        let { historial: historialBitrix, resumenHistorial } = await checkContactHistory(chatId, true);

        // if (!historialBitrix) {
        //     const mensajeDefault = "Hola, ¿en qué puedo ayudarte hoy?";
        //     await registrarSeguimientoEnBitrix(chatId, mensajeDefault, '');
        //     return { respuesta: mensajeDefault };
        // }

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
${historialBitrix}


${resumenHistorial
                ? 'Resumen de la conversación:\n' + resumenHistorial
                : ''
            }

No repitas siempre los mismo cada vez que se haga un seguimiento, para que parezca más natural el seguimiento

Mensaje de seguimiento:`;

        const response = await openai.chat.completions.create({
            model: "gpt-5",
            messages: [{
                role: "system",
                content: "Eres un asistente experto en redactar mensajes de seguimiento para clientes de inmigración. Usa un tono cálido y profesional, estilo WhatsApp."
            }, {
                role: "user",
                content: prompt
            }],
            // temperature: 0.5
        });

        const mensajeSeguimiento = response.choices[0].message.content;

        // Registrar el seguimiento en Bitrix24
        await registrarSeguimientoEnBitrix(chatId, mensajeSeguimiento, historialBitrix);

        return { respuesta: mensajeSeguimiento };

    } catch (error) {
        console.error("Error al generar mensaje de seguimiento:", error.message);
        const mensajeError = "Hola, ¿sigues interesado en el trámite que hablamos anteriormente?";
        await registrarSeguimientoEnBitrix(chatId, mensajeError, '');
        return { respuesta: mensajeError };
    }
}

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

async function responderConPdf(preguntaUsuario, chatId, channelId) {
    // Obtener historial directamente de Bitrix24
    const historialBitrix = await checkContactHistory(chatId);

    // Recuperar fragments relevantes
    const topFragments = await recuperarFragments(preguntaUsuario, 3);

    // Construir contexto con fragments
    let contextoDocumento = "Información relevante:\n";
    topFragments.forEach((fragmento, idx) => {
        contextoDocumento += `--- Fragmento ${idx + 1} ---\n${fragmento.texto}\n\n`;
    });

    // Hora actual en UTC-4
    const dateInTimeZone = moment.tz("America/Caracas").format();

    const messages = [
        {
            role: "system",
            content: `Hora actual ${dateInTimeZone}\n
Asistente virtual de WhatsApp del equipo de "Tu Agente de Inmigración". Tono: Cercano, humano, profesional pero natural. Puede usar pequeños errores ortográficos y abreviaciones comunes. Estilo: Mensajes cortos (1 a 2 líneas máx.), tipo chat humano.
Siempre que pregunte por un servicio, dile los presios y si gusta pagar para seguir con el proceso de desea.

${text}

${historialBitrix ? historialBitrix : ''}

${historialBitrix !== '' ? 'Estudia el historial y responde en base a lo que ya se ha hablado con el cliente' : ''}
`
        },
        {
            role: "user",
            content: preguntaUsuario
        }
    ];

    // console.log(historialBitrix.split('\n'))

    // return

    // Generar respuesta
    const completion = await openai.chat.completions.create({
        model: "gpt-5",
        messages,
        // temperature: 0.7
    });

    const respuesta = completion.choices[0].message.content;

    let ultimoMensaje = getLastConversation(historialBitrix.split('\n'))

    ultimoMensaje += '\n' + `- Cliente: ${preguntaUsuario}\n- Asistente IA: ${respuesta}`

    // Verificar si la respuesta indica una transferencia a agente
    const transferenciaDetectada = await verificarTransferenciaAgente(chatId, respuesta, ultimoMensaje, historialBitrix);
    console.log('transferenciaDetectada', transferenciaDetectada)

    if (transferenciaDetectada) {

        const [responseResumen, responseNotif] = await Promise.all([obtenerResumenHistorial(chatId, historialBitrix), notificarTransferenciaAgente(chatId, respuesta)])

        await updateLeadField(chatId, responseResumen, channelId)
    }

    return { respuesta, chatId, preguntaUsuario, history: [{ pregunta: preguntaUsuario, respuesta }], historialBitrix };
}

const getLastConversation = (conversation) => {
    // Filtrar las líneas no vacías
    const filteredConversation = conversation.filter(line => line.trim() !== '');

    // La última conversación sería el último intercambio de mensajes
    let lastMessage = filteredConversation[filteredConversation.length - 2];
    lastMessage += '\n' + filteredConversation[filteredConversation.length - 1];

    return lastMessage;
};

async function verificarTransferenciaAgente(chatId, ultimaRespuesta, ultimosDosMensajes, historialBitrix) {
    // console.log('ultimosDosMensajes', ultimosDosMensajes)
    try {
        const prompt = `Analiza el siguiente mensaje y determina si indica que el cliente será transferido a un agente humano. 
Responde solo con "SI" o "NO".
Si el cliente quiere hacer el pago también tienes que decir "SI".
Cuando el mensaje a analizar diga que va a ser transferido con un agente afirmativamente, puedes decir "SI". Si lo hace en forma de pregunta como: "puedo agendarte con un asesor experto para avanzar con este paso. ¿Te gustaría que lo haga ahora?" tienes que responder "NO", y si el cliente quiere abanzar con el proceso, también debes decir "SI".
Si se habla de pago debes decir "SI".
Si ya se le dijo al cliente cuando le gustaría que lo contacten, y el cliente ya respondió, también debes responder "SI".
Debes decir "SI" si el cliente muestra enojo o frustración
Si ya el cliente ha enviado dos mensajes, debes decir "SI"

Contexto de conversación:
${ultimosDosMensajes}

Historial completo de conversación:
${historialBitrix}
`;

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{
                role: "system",
                content: 'Eres un asistente que solo responde con SI o NO, indicando si el mensaje significa que el cliente será transferido a un agente humano.'
            }, {
                role: "user",
                content: prompt
            }],
            // temperature: 0,
            // max_tokens: 2
        });

        return response.choices[0].message.content.trim().toUpperCase() === "SI";
    } catch (error) {
        console.error("Error al verificar transferencia a agente:", error);
        return false;
    }
}

async function notificarTransferenciaAgente(chatId, mensajeTransferencia) {
    try {
        // 1. Obtener información del contacto/lead
        const leadResponse = await axios.get(
            `${BITRIX24_API_URL}crm.lead.list?FILTER[PHONE]=%2B${chatId}&SELECT[]=ID&SELECT[]=CONTACT_ID&SELECT[]=ASSIGNED_BY_ID&SELECT[]=UF_CRM_1755093738`
        );

        let entityId, isContact = false, assignedTo;

        if (leadResponse.data.result && leadResponse.data.result.length > 0) {
            const lead = leadResponse.data.result[leadResponse.data.result.length - 1];
            entityId = lead.ID;
            assignedTo = lead.UF_CRM_1755093738 || lead.ASSIGNED_BY_ID;

            // if (lead.CONTACT_ID && lead.CONTACT_ID !== '0') {
            //     const contactResponse = await axios.get(
            //         `${BITRIX24_API_URL}crm.contact.get?id=${lead.CONTACT_ID}&SELECT[]=ASSIGNED_BY_ID`
            //     );

            //     if (contactResponse.data.result) {
            //         entityId = contactResponse.data.result.ID;
            //         assignedTo = contactResponse.data.result.ASSIGNED_BY_ID;
            //         isContact = true;
            //     }
            // }
        }

        if (!assignedTo) {
            console.log("No se encontró agente asignado para notificar");
            return;
        }

        // 2. Crear notificación en Bitrix24
        const notificationText = `Se te ha transferido el cliente con el número de teléfono ${chatId}`;

        // await axios.post(`${BITRIX24_API_URL}im.notify`, {
        //     to: assignedTo,
        //     message: notificationText,
        //     type: "SYSTEM"
        // });

        await sendDirectMessage(assignedTo, notificationText)

        console.log(`Notificación de transferencia enviada al agente ${assignedTo}`);
    } catch (error) {
        console.error("Error al notificar transferencia a agente:", error.message);
    }
}

async function sendDirectMessage(userId, message) {
    if (!BITRIX24_API_URL) throw new Error("Falta BITRIX24_API_URL en variables de entorno");
    if (!userId) throw new Error("Falta userId (ID numérico del empleado)");
    if (!message) throw new Error("Falta message");

    try {
        const url = `https://tuagentedeinmigracion.bitrix24.co/rest/9795/iyud3674l753r33a/im.message.add.json`;
        const payload = {
            DIALOG_ID: userId,          // <- DM al usuario
            MESSAGE: message,           // texto plano o con BBCode simple
        };
    
        const { data } = await axios.post(url, payload);
        if (data.error) throw new Error(`${data.error}: ${data.error_description}`);
        return data.result; // ID del mensaje enviado
    } catch (error) {
        console.log(error)
    }
}

async function updateLeadField(phoneNumber, resumenHistorial, channelId) {
    try {
        // Primero obtener el ID del lead
        const response = await axios.get(`${BITRIX24_API_URL}crm.lead.list?FILTER[PHONE]=%2B${phoneNumber}&SELECT[]=ID&SELECT[]=UF_CRM_1752006453&SELECT[]=ASSIGNED_BY_ID`);

        if (!response.data.result || response.data.result.length === 0) {
            console.log(`No se encontró lead con número ${phoneNumber}`);
            return null;
        }

        const leadId = response.data.result[response.data.result.length - 1].ID;
        const responsible = response.data.result[response.data.result.length - 1].ASSIGNED_BY_ID;
        const respondiendoChatbot = response.data.result[response.data.result.length - 1].UF_CRM_1752006453;

        if (respondiendoChatbot != '2709') {
            return null
        }

        const leadUpdateData = {
            id: leadId,
            fields: {
                "UF_CRM_1752006453": 2711,
                "STATUS_ID": "UC_11XRR5",
                "UF_CRM_1755880170": channelId || ''
            }
        };

        const commentData = {
            fields: {
                "ENTITY_ID": leadId,
                "ENTITY_TYPE": "lead",
                "COMMENT": resumenHistorial,
                "AUTHOR_ID": responsible, // ID del usuario que realiza la acción
            }
        };

        const [updateResponse, commentResponse] = await Promise.all([
            axios.post(`${BITRIX24_API_URL}crm.lead.update`, leadUpdateData),
            axios.post(`${BITRIX24_API_URL}crm.timeline.comment.add`, commentData)
        ]);

        console.log(`🔄 Lead ${leadId} actualizado. Campo UF_CRM_1752006453 establecido a 2711`);
        return updateResponse.data.result;
    } catch (error) {
        console.error('Error al actualizar lead en Bitrix24:', error.response?.data || error.message);
        throw error;
    }
}

async function checkContactHistory(chatId, obtenerResumen = false) {
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

    } catch (error) {
        console.error("Error al verificar el historial en Bitrix24:", error.message);
    }

    // Retorno por defecto
    if (obtenerResumen) {
        return { historial: '', resumenHistorial: '', entityType: null };
    }
    return '';
}

async function updateContactHistory(chatId, history, historialExistente, channelId) {
    try {
        // Primero buscar el Lead que contenga este número de teléfono
        const leadResponse = await axios.get(`${BITRIX24_API_URL}crm.lead.list?FILTER[PHONE]=%2B${chatId}&SELECT[]=ID&SELECT[]=CONTACT_ID&SELECT[]=${BITRIX24_HISTORIAL_FIELD}`);

        let entityId, leadId, isContact = false, entityType = 'lead';
        let existingHistory = historialExistente || '';

        if (leadResponse.data.result && leadResponse.data.result.length > 0) {
            const lead = leadResponse.data.result[leadResponse.data.result.length - 1];
            entityId = lead.ID;
            leadId = lead.ID;
            existingHistory = lead[BITRIX24_HISTORIAL_FIELD] || existingHistory;

            // Si el Lead tiene contacto asociado, usaremos el contacto en lugar del lead
            if (lead.CONTACT_ID && lead.CONTACT_ID !== '0') {
                const contactResponse = await axios.get(`${BITRIX24_API_URL}crm.contact.get?id=${lead.CONTACT_ID}&SELECT[]=ID&SELECT[]=${BITRIX24_HISTORIAL_FIELD}`);
                if (contactResponse.data.result) {
                    entityId = contactResponse.data.result.ID;
                    existingHistory = contactResponse.data.result[BITRIX24_HISTORIAL_FIELD] || existingHistory;
                    isContact = true;
                    entityType = 'contact';
                }
            }
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
        if (!existingHistory || existingHistory.length === 0) {
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

        if (channelId && channelId !== '') updateData.UF_CRM_1755880170 = channelId;

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
            // Seguimiento 1 === UC_61ZU35
            if (leadStatusResponse.data.result.STATUS_ID === "UC_61ZU35") {
                await axios.post(`${BITRIX24_API_URL}bizproc.workflow.start`, {
                    TEMPLATE_ID: 773,
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

async function obtenerResumenHistorial(chatId, historial) {
    try {
        let historialCompleto = historial;

        if (!historialCompleto) {
            const historialBitrix = await checkContactHistory(chatId);
            historialCompleto = historialBitrix || '';
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
            // temperature: 0.3
        });

        return resumenResponse.choices[0].message.content;

    } catch (error) {
        console.error("Error al obtener resumen del historial:", error.message);
        return "Error al generar el resumen de la conversación.";
    }
}

const guardarResumenHistorial = async (entityId, resumenHistorial, isContact = true) => {
    try {
        const contactField = 'UF_CRM_1754666415';
        const leadField = 'UF_CRM_1754666415';

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

async function responderFueraDeHorario(chatId, mensajeCliente) {
    try {
        // Obtener la hora actual en UTC-4 (America/Caracas)
        const now = moment().tz("America/Caracas");
        const dayName = now.format('dddd').toLowerCase();
        const horaActual = now.hours();


        // Definir horario laboral (8 AM a 7 PM UTC-4)
        const horaInicioLaboral = 8;
        // const horaFinLaboral = 19;

        let notaImportante = dayName !== 'sunday' && horaActual < horaInicioLaboral ? 'Perfecto, quedas agendado para hoy a las [hora que dijo el cliente que quiería ser contactado, si el cliente no dijo hora, por defecto di que será contactado a las 8:00 AM]' : 'Perfecto, quedas agendado para el día [de mañana o el día de la semana que se le contactará] a las [hora que dijo el cliente que quiería ser contactado]'

        // // Verificar si está fuera del horario laboral
        // const fueraDeHorario = horaActual < horaInicioLaboral || horaActual >= horaFinLaboral;

        // if (!fueraDeHorario) {
        //     return null; // No es necesario responder si está dentro del horario
        // }

        // Obtener historial del cliente desde Bitrix24
        const { historial: historialBitrix, resumenHistorial } = await checkContactHistory(chatId, true);

        // Generar respuesta personalizada basada en el historial
        const prompt = `Eres un asistente de una agencia de trámites migratorios. Trabajamos de Lunes a Sábado de 8:00 AM a 7:00 PM horario de Miami, si por ejemplo, un cliente escribe un Sábado después de las 8:00 PM, le dices que será contactado el día Lunes a primera hora.
Nombre del día de hoy: ${dayName}
Hora actual: 8:00 PM

Basado en el siguiente historial de conversación, redacta un mensaje para el cliente explicando que:
1. Estamos fuera del horario laboral
2. Un agente le responderá en la mañana siguiente
3. Mencione brevemente el tema de la conversación previa para mostrar continuidad
4. Use un tono cálido y profesional
5. Si el cliente está en medio de un proceso de pago o trámite urgente, añadir que se le dará prioridad
6. La única pregunta que se le puede hacer al cliente es si desea que lo contacten a primera hora del día siguiente o en la tarde
7. Si le respondiste al cliente hacer 1 hora o menos, no vuelvas a escribir lo mismo de antes, solo continúa la conversación, la hora del último mensaje aparece así: [2025-08-18 23:37:34], justo arruba de donde dice "- Cliente:"
8. IMPORTANTE: Si el cliente ya no hace más preguntas y solo dice "ok", "gracias" o algo parecido, simplemente dile "${notaImportante}"
9. El mensaje debe ser breve, claro y lo más corto posible.
10. No uses signos de exclamación, solo puntos (.) y comas (,), y el signo de interrogación ponlo solo al final de la oración, para que el mensaje tenga pequeños errores y parezca que fué escrito por un humano.

Historial de conversación:
${historialBitrix || 'No hay historial previo'}

Resumen de la conversación:
${resumenHistorial || 'No hay resumen disponible'}

Mensaje del cliente:
${mensajeCliente}
`;

        const response = await openai.chat.completions.create({
            model: "gpt-5",
            messages: [{
                role: "system",
                content: "Eres un asistente experto en redactar mensajes para clientes de inmigración. Usa un tono cálido y profesional, estilo WhatsApp, y sin signos de exclamación."
            }, {
                role: "user",
                content: prompt
            }]
        });

        const respuesta = response.choices[0].message.content;

        // Registrar la interacción en Bitrix24
        const historialFormateado = `[${now.format('YYYY-MM-DD HH:mm:ss')}]\n- Cliente: ${mensajeCliente}\n- Asistente IA: ${respuesta}\n\n`;

        // await registrarSeguimientoEnBitrix(chatId, respuesta, historialBitrix ? historialBitrix + historialFormateado : historialFormateado);

        return { respuesta, historialBitrix, history: [{ pregunta: mensajeCliente, respuesta }] };

    } catch (error) {
        console.error("Error en responderFueraDeHorario:", error.message);

        // Respuesta por defecto en caso de error
        const respuestaDefault = "¡Gracias por tu mensaje! Actualmente estamos fuera del horario laboral. Un agente te contactará mañana para ayudarte.";

        try {
            await registrarSeguimientoEnBitrix(chatId, respuestaDefault, '');
        } catch (err) {
            console.error("Error al registrar respuesta por defecto:", err.message);
        }

        return { respuesta: respuestaDefault };
    }
}



module.exports = {
    responderConPdf,
    generarMensajeSeguimiento,
    updateContactHistory,
    guardarResumenHistorial,
    obtenerResumenHistorial,
    updateLeadField,
    responderFueraDeHorario
};