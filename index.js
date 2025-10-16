require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const axios = require("axios");
const { responderConPdf, obtenerResumenHistorial, generarMensajeSeguimiento, updateContactHistory, updateLeadField, responderFueraDeHorario, notificarTransferenciaAgente } = require("./consulta_empresa.js");
const sendMessage = require('./sendMessage.js')
const moment = require('moment-timezone');

const app = express();
app.use(cors());
app.use(express.json());

// Configuración de OpenAI (ChatGPT)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const OPENAI_API_URL = 'https://api.openai.com/v1/audio/transcriptions';

// Configuración de Bitrix24
const BITRIX24_API_URL = process.env.BITRIX24_API_URL;
// const BITRIX24_LIST_FIELD_ID = process.env.BITRIX24_LIST_FIELD_ID || 'UF_CRM_1752006453';
// const BITRIX24_LIST_VALUE = process.env.BITRIX24_LIST_VALUE || '2223'; // Yes
// const BITRIX24_ADMIN_VALUE = process.env.BITRIX24_ADMIN_VALUE || '2225'; // Valor para Admin
const BITRIX24_LIST_FIELD_ID = 'UF_CRM_1752006453';
const BITRIX24_LIST_VALUE = '2223'; // Yes
const BITRIX24_ADMIN_VALUE = '2225'; // Valor para Admin

app.get('/', async (req, res) => {
  return res.json({ message: 'Última cambio manual del servidor el día 10/09/2025 16:16' })
})

app.get('/send-message', async (req, res) => {

  sendMessage('Test desde la api', '584129253568')

  return res.json({ message: 'Mensaje enviado' })
})

// app.post('/mensaje-recordatorio', async (req, res) => {})

app.post('/seguimientos', async (req, res) => {

  const { phone, trackingNumber, channel } = req.query;

  if (channel && channel.trim() == '37e572a1-a8ec-460e-b71a-881f831ca905') {
    return res.json({ message: 'El mensaje no se enviará porque es del canal 561' })
  }
  else if (channel && channel.trim() == '5cd1eb6b-8174-47dc-a8a2-dd1340883925') {
    return res.json({ message: 'El mensaje no se enviará porque es del canal 561' })
  }

  console.log('phone', phone)
  console.log('trackingNumber', trackingNumber)

  try {
    let chatId = phone.split(',')[0].trim();

    chatId = chatId.replace(/\D/g, '');

    const leadResponse = await axios.get(
      `${BITRIX24_API_URL}crm.lead.list?FILTER[PHONE]=%2B${chatId}&SELECT[]=ID&SELECT[]=STATUS_ID`
    );
    const lead = leadResponse.data.result[leadResponse.data.result.length - 1];

    if (lead.STATUS_ID == "UC_EMY4OP") {
      return res.json({ message: 'El mensaje no se enviará porque está en "Seguimiento 2"' })
    }

    const zonaHoraria = 'America/New_York';
    const horaEnZona4 = moment().tz(zonaHoraria);
    const soloHora24h = horaEnZona4.format('H');
    console.log(`Hora en formato de 24h: ${soloHora24h}`);

    if (soloHora24h < 7 || soloHora24h > 19) {
      console.log('Se iba a enviar seguimiento antes del horario laboral, hora: ' + soloHora24h + '\n' + 'Teléfono del cliente: ' + chatId)
      const leadResponse = await axios.get(
        `${BITRIX24_API_URL}crm.lead.list?FILTER[PHONE]=%2B${chatId}&SELECT[]=ID`
      );

      if (leadResponse.data.result && leadResponse.data.result.length > 0) {
        const lead = leadResponse.data.result[leadResponse.data.result.length - 1];
        await axios.post(`${BITRIX24_API_URL}bizproc.workflow.start`, {
          TEMPLATE_ID: 797,
          DOCUMENT_ID: [
            'crm',
            'CCrmDocumentLead',
            `LEAD_${lead.ID}`
          ],
        });
      }
      return res.json({ message: 'Tiene que esperar 8 horas para que le mensaje sea enviado' })
    }

    const { respuesta } = await generarMensajeSeguimiento(chatId, trackingNumber);

    // Enviar respuesta
    console.log('respuesta', respuesta)
    console.log('chatId', chatId)
    await sendMessage(respuesta, chatId, 'seguimiento', channel)
    return res.json({ message: 'Mensaje de recordatorio enviado' })

  } catch (error) {
    console.log(error)
  }
})

// Agrega estas variables globales al inicio de tu archivo
const messageBuffers = new Map();

// Función para procesar mensajes en buffer
async function processBufferedMessages(chatId, idSecuencia, channelId) {

  const { message } = messageBuffers.get(chatId);

  // Procesar el mensaje combinado
  try {
    // Verificar el contacto en Bitrix24 y el valor del campo específico
    const shouldRespond = await checkContactAndFieldValue(chatId);
    console.log('shouldRespond', shouldRespond);

    if (!shouldRespond && typeof shouldRespond === "boolean") {
      console.log(`No se responderá al contacto ${chatId} (el campo no tiene el valor requerido o el contacto no existe)`);
      messageBuffers.get(chatId).message = ''
      return;
    }

    // Procesar mensaje combinado
    let info = {};
    if (shouldRespond === 'Fuera de horario') {
      info = await responderFueraDeHorario(chatId, message);
    }
    else if (shouldRespond === 'create') {
      await createContactInBitrix24(chatId, null || 'Cliente WhatsApp', message, channelId);
      return
    }
    else {
      info = await responderConPdf(message, chatId, channelId);
    }

    const { respuesta, history, historialBitrix } = info;

    if (idSecuencia != messageBuffers.get(chatId).idSecuencia) {
      console.log('Entró otro mensajeantes antes de enviar la respuesta')
      return;
    }
    messageBuffers.get(chatId).message = ''

    await sendMessage(respuesta, chatId, null, messageBuffers.get(chatId).channelId);
    updateContactHistory(chatId, history, historialBitrix, channelId);
    console.log('✅ Respuesta enviada:', respuesta);

  } catch (error) {
    console.error(`❌ Error procesando mensajes agrupados para ${chatId}:`, error);
  }
}

const modifyNumber = (number, position = 3) => number.startsWith('+52') ? number.slice(0, position) + '1' + number.slice(position) : number

app.post('/webhook', async (req, res) => {
  try {
    const { messages } = req.body;

    if (!messages) {
      if (req.body.test) {
        console.log('Webhook conectado');
        return res.status(200).json({ status: 200 });
      }
      console.log('No se recibió ningún mensaje');
      return res.status(200).send("OK");;
    }

    let message = messages[0];
    let { chatId, type, sentFromApp, authorName, authorId, status, isEcho, text, messageId, channelId } = message;

    chatId = modifyNumber(chatId)

    // if (chatId !== '19545480212' && chatId !== '584129253568') {
    //   console.log('chatId', chatId, 'Es diferente a 19545480212');
    //   return res.status(200).send("OK");;
    // }

    // Mensajes de admin se procesan inmediatamente
    if (authorId && parseInt(authorId) > 0) {
      console.log(`🛠️ Mensaje de Admin recibido para ${chatId}`);

      try {
        let response = await runWorkflowMoverASeguimiento2(chatId);

        if (response) {
          const resumenHistorial = await obtenerResumenHistorial(chatId);
          console.log(`📜 Resumen profesional de la conversación con ${chatId}:\n`);
          console.log(resumenHistorial);
          console.log('\n' + '-'.repeat(50) + '\n');

          await updateLeadField(chatId, resumenHistorial, channelId);
        }

      } catch (error) {
        console.error('Error al procesar mensaje de admin:', error);
      }

      return res.status(200).send("OK");;
    }

    if (sentFromApp || status == 'read' || authorName === 'Admin' || status === 'delivered' || status !== 'inbound' || isEcho) {
      console.log('El mensaje no es de un usuario real o ya fue procesado número: ' + chatId);
      return res.status(200).send("OK");
    }

    let idSecuencia = Date.now()

    if (!messageBuffers.has(chatId)) {
      messageBuffers.set(chatId, { messagesIds: [], message: text, idSecuencia, channelId });
    }
    else {
      messageBuffers.get(chatId).messagesIds.push(messageId);
      messageBuffers.get(chatId).message += messageBuffers.get(chatId).message == '' ? text : '\n' + text
      messageBuffers.get(chatId).idSecuencia = idSecuencia
      messageBuffers.get(chatId).channelId = channelId
    }

    let messageContent = '';

    // Extraer el contenido del mensaje
    if (type === 'text') {
      messageContent = message.text;
      console.log(`📩 Mensaje de texto de ${chatId}: ${messageContent}`);
    }
    else if (type === 'audio') {
      const contentUri = message.contentUri;
      console.log(`🎤 Nota de voz recibida de ${chatId}`);

      try {
        const audiosDir = path.join(__dirname, 'audios');
        if (!fs.existsSync(audiosDir)) {
          fs.mkdirSync(audiosDir);
        }

        const fileName = `audio-${Date.now()}.mp3`;
        const filePath = path.join(audiosDir, fileName);

        const response = await axios({
          method: 'get',
          url: contentUri,
          responseType: 'stream',
        });

        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });

        console.log(`✅ Audio guardado en: ${filePath}`);

        const transcription = await transcribeAudio(filePath);
        messageContent = transcription;
        console.log(`📝 Transcripción del audio: ${transcription}`);
        messageBuffers.get(chatId).message += messageBuffers.get(chatId).message == '' ? transcription : '\n' + transcription

        try {
          fs.unlinkSync(filePath);
          console.log(`🗑️ Audio eliminado: ${filePath}`);
        } catch (err) {
          console.error('Error al eliminar el archivo de audio:', err);
        }

      } catch (error) {
        console.error('Error al procesar el audio:', error.message);
        // Aún así responder para no dejar al usuario sin respuesta
        messageContent = "[Mensaje de voz no procesado completamente]";
      }
    }
    else {
      const resumenHistorial = await obtenerResumenHistorial(chatId);
      console.log(`El cliente a enviado un documento u otro tipo de archivo que no es texto o audio`);

      await updateLeadField(chatId, resumenHistorial, channelId);
      return res.status(200).send("OK");
    }

    if (!messageContent) {
      return res.status(200).send("OK");
    }

    // Agregar mensaje al buffer para agruparlo
    // addToBuffer(chatId, {
    //   message,
    //   chatId,
    //   type,
    //   sentFromApp,
    //   authorName,
    //   authorId,
    //   status,
    //   isEcho
    // }, messageContent);

    processBufferedMessages(chatId, idSecuencia, channelId);

    return res.status(200).send("OK");

  } catch (error) {
    console.error('Error en webhook:', error);
    res.status(500).json({ error: 'Ocurrió un error' });
  }
});

app.post('/resend-message', async (req, res) => {

  const { phone } = req.query;

  try {

    let chatId = phone.split(',')[0].trim();
    chatId = chatId.replace(/\D/g, '');

    let message;
    let channelId;

    try {

      const contactResponse = await axios.get(
        `${BITRIX24_API_URL}crm.contact.list?FILTER[PHONE]=%2B${chatId}&SELECT[]=ID&SELECT[]=UF_CRM_1756909989&SELECT[]=UF_CRM_68A8DCEC8EF2D`
      );

      if (contactResponse.data.result && contactResponse.data.result.length > 0) {
        const contact = contactResponse.data.result[contactResponse.data.result.length - 1];

        message = contact.UF_CRM_1756909989;
        channelId = contact.UF_CRM_68A8DCEC8EF2D;
      }

    } catch (error) {
      console.log('Error al buscar contacto en B24:', error)
    }

    // Verificar el contacto en Bitrix24 y el valor del campo específico
    const shouldRespond = await checkContactAndFieldValue(chatId);
    console.log('shouldRespond', shouldRespond);

    if (!shouldRespond && typeof shouldRespond === "boolean") {
      console.log(`No se responderá al contacto ${chatId} (el campo no tiene el valor requerido o el contacto no existe)`);
      return;
    }

    // Procesar mensaje combinado
    let info = {};
    if (shouldRespond === 'Fuera de horario') {
      info = await responderFueraDeHorario(chatId, message);
    }
    else {
      info = await responderConPdf(message, chatId, channelId);
    }

    const { respuesta, history, historialBitrix } = info;

    await sendMessage(respuesta, chatId, null, channelId);
    updateContactHistory(chatId, history, historialBitrix, channelId);
    console.log('✅ Respuesta enviada:', respuesta);

  } catch (error) {
    console.error(`❌ Error procesando mensajes agrupados para ${chatId}:`, error);
  }

})

// Función para calcular el tiempo de espera basado en palabras
function calcularTiempoEscritura(texto) {
  const palabras = texto.trim().split(/\s+/).length;

  if (palabras <= 5) return Math.random() * 1.5 + 1.5; // 1.5-3 segundos
  if (palabras <= 15) return Math.random() * 3 + 3;    // 3-6 segundos
  if (palabras <= 30) return Math.random() * 4 + 5;    // 5-9 segundos
  if (palabras <= 50) return Math.random() * 5 + 8;    // 8-13 segundos
  if (palabras <= 80) return Math.random() * 6 + 12;   // 12-18 segundos
  if (palabras <= 120) return Math.random() * 8 + 17;  // 17-25 segundos
  return Math.random() * 10 + 25;                     // 25-35 segundos
}

// Función para esperar un tiempo determinado
function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Función para transcribir audio a texto usando OpenAI
async function transcribeAudio(filePath) {
  try {
    const audioFile = fs.createReadStream(filePath);
    const form = new FormData();
    form.append('file', audioFile);
    form.append('model', 'whisper-1');

    const response = await axios.post(OPENAI_API_URL, form, {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        ...form.getHeaders()
      }
    });

    return response.data.text;
  } catch (error) {
    console.error('Error al transcribir el audio:', error.response?.data || error.message);
    throw error;
  }
}

async function runWorkflowMoverASeguimiento2(phoneNumber) {
  try {
    const leadResponse = await axios.get(
      `${BITRIX24_API_URL}crm.lead.list?FILTER[PHONE]=%2B${phoneNumber}&SELECT[]=ID&SELECT[]=CONTACT_ID&SELECT[]=${BITRIX24_LIST_FIELD_ID}&SELECT[]=STATUS_ID&SELECT[]=UF_CRM_1755093738&SELECT[]=ASSIGNED_BY_ID`
    );
    if (leadResponse.data.result && leadResponse.data.result.length > 0) {

      let lead = leadResponse.data.result[leadResponse.data.result.length - 1]

      if (lead.STATUS_ID === "UC_11XRR5") {
        await axios.post(`${BITRIX24_API_URL}bizproc.workflow.start`, {
          TEMPLATE_ID: 773,
          DOCUMENT_ID: [
            'crm',
            'CCrmDocumentLead',
            `LEAD_${lead.ID}`
          ],
        });
      }

      return lead[BITRIX24_LIST_FIELD_ID] == BITRIX24_LIST_VALUE
    }
  } catch (error) {
    console.log(error)
  }
}

// Función para verificar contacto y valor del campo en Bitrix24
async function checkContactAndFieldValue(phoneNumber) {
  const now = moment().tz("America/Caracas");
  const horaActual = now.hours();
  const horaInicioLaboral = 8;
  const horaFinLaboral = 19;
  const fueraDeHorario = horaActual < horaInicioLaboral || horaActual >= horaFinLaboral;

  // Función para modificar el número si empieza con 521 (quitar el 1 en posición 2)
  const modificarNumero = (numero) => {
    if (numero.startsWith('521') && numero.length > 3) {
      return '52' + numero.substring(3);
    }
    return numero;
  };

  // Función para buscar el lead
  const buscarLead = async (numeroABuscar) => {
    let lead;

    try {
      const leadResponse = await axios.get(
        `${BITRIX24_API_URL}crm.lead.list?FILTER[PHONE]=%2B${numeroABuscar}&SELECT[]=ID&SELECT[]=CONTACT_ID&SELECT[]=${BITRIX24_LIST_FIELD_ID}&SELECT[]=STATUS_ID&SELECT[]=UF_CRM_1755093738&SELECT[]=ASSIGNED_BY_ID`
      );

      if (leadResponse.data.result && leadResponse.data.result.length > 0) {
        lead = leadResponse.data.result[leadResponse.data.result.length - 1];

        if (lead.STATUS_ID === "UC_EMY4OP" && lead.STATUS_ID !== "UC_11XRR5") {
          await axios.post(`${BITRIX24_API_URL}crm.lead.update`, {
            id: lead.ID,
            fields: {
              "ASSIGNED_BY_ID": lead.UF_CRM_1755093738,
              "STATUS_ID": "UC_11XRR5"
            }
          });
          console.log('Se le transfirió a un agente');
          if (fueraDeHorario) {
            return 'Fuera de horario';
          }
          notificarTransferenciaAgente(numeroABuscar)
          return false;
        }
        else if (lead.STATUS_ID === "UC_11XRR5") {
          return false;
        }

        for (const lead of leadResponse.data.result) {
          if (lead[BITRIX24_LIST_FIELD_ID] === '2709' && (lead.STATUS_ID == "UC_61ZU35" || lead.STATUS_ID == "UC_EMY4OP")) {
            return true;
          }
        }
      }

      return null; // Retorna null cuando no encuentra el lead para continuar el bucle

    } catch (error) {
      console.error('Error al verificar lead/contacto en Bitrix24:', error.response?.data || error.message);
      throw error;
    }
  };

  // Bucle de búsqueda con máximo 24 intentos (2 minutos)
  const realizarBusqueda = async (numero) => {
    let intentos = 0;
    const maxIntentos = 24;
    const intervalo = 5000; // 5 segundos

    while (intentos < maxIntentos) {
      const resultado = await buscarLead(numero);

      // Si se encuentra un resultado válido (true, false o string), lo retornamos
      if (resultado !== null) {
        return resultado;
      }

      intentos++;

      // Si no es el último intento, esperamos 5 segundos
      if (intentos < maxIntentos) {
        console.log(`${numero} Lead no encontrado. Intento ${intentos}/${maxIntentos}. Esperando 5 segundos...`);
        await new Promise(resolve => setTimeout(resolve, intervalo));
      }
    }

    console.log(`${numero} Lead no encontrado después de ${maxIntentos} intentos de ${intervalo} segundos.`);
    return null;
  };

  // Primera búsqueda con el número original
  let resultado = await realizarBusqueda(phoneNumber);
  
  // Si no se encontró y el número empieza con 521, hacer segunda búsqueda con número modificado (quitando el 1)
  if (resultado === null && phoneNumber.startsWith('521')) {
    const numeroModificado = modificarNumero(phoneNumber);
    console.log(`Realizando segunda búsqueda con número modificado: ${numeroModificado}`);
    resultado = await realizarBusqueda(numeroModificado);
  }

  // Si después de ambas búsquedas no se encontró nada, buscar contacto
  if (resultado === null) {
    console.log(`${phoneNumber} Lead no encontrado después de ambas búsquedas. Buscando contacto...`);
    
    // Buscar contacto por número de teléfono
    try {
      const contactResponse = await axios.get(
        `${BITRIX24_API_URL}crm.contact.list?FILTER[PHONE]=%2B${phoneNumber}&SELECT[]=ID&SELECT[]=${BITRIX24_LIST_FIELD_ID}&SELECT[]=UF_CRM_68A8DCEC8EF2D&SELECT[]=NAME&SELECT[]=LAST_NAME`
      );

      if (contactResponse.data.result && contactResponse.data.result.length > 0) {
        // const contact = contactResponse.data.result[contactResponse.data.result.length - 1];
        //   console.log('Buscando el contacto')
        // if (contact.UF_CRM_68A8DCEC8EF2D == null || contact.UF_CRM_68A8DCEC8EF2D == '') {
        //   console.log('contacto encontrado')

        //   let titleLead = contact.NAME + (contact.LAST_NAME ? ' ' + contact.LAST_NAME : '')

        //   await axios.post(`${BITRIX24_API_URL}crm.lead.add`,
        //     {
        //       fields:
        //       {
        //         TITLE: titleLead,
        //         NAME: contact.NAME,
        //         LAST_NAME: contact.LAST_NAME,
        //         STATUS_ID: 'UC_61ZU35',
        //         ASSIGNED_BY_ID: 9795,
        //         PHONE: [
        //           {
        //             VALUE: `+${phoneNumber}`,
        //             VALUE_TYPE: 'WORK',
        //           },
        //         ]
        //       }
        //     }
        //   )

        //   return false
        // }
      } else if (lead && lead.STATUS_ID == "UC_61ZU35") {
        console.log('Contacto no encontrado. Se debe crear uno nuevo.');
        return 'create'; // Retornar 'create' para indicar que se debe crear un nuevo contacto
      }
      return false
    } catch (error) {
      console.error('Error al buscar contacto en Bitrix24:', error.response?.data || error.message);
      return false; // En caso de error, también retornar 'create'
    }
  }

  return resultado;
}

// Función para crear un nuevo contacto en Bitrix24
async function createContactInBitrix24(phoneNumber, name, messageCustomer, channelId) {
  try {
    const contactData = {
      NAME: name || 'Cliente WhatsApp',
      PHONE: [{ VALUE: `+${phoneNumber}`, VALUE_TYPE: 'WORK' }],
      [BITRIX24_LIST_FIELD_ID]: BITRIX24_LIST_VALUE, // Asignar valor al campo de lista
      UF_CRM_1756909989: messageCustomer,
      UF_CRM_68A8DCEC8EF2D: channelId,
      ASSIGNED_BY_ID: 9795 // ID del bot
    };

    const response = await axios.post(`${BITRIX24_API_URL}crm.contact.add`, {
      fields: contactData
    });

    console.log(`✅ Contacto creado en Bitrix24 con ID: ${response.data.result}`);
    return response.data.result;
  } catch (error) {
    console.error('Error al crear contacto en Bitrix24:', error.response?.data || error.message);
    throw error;
  }
}

// Función para actualizar un campo de un contacto en Bitrix24
async function updateContactField(phoneNumber, fieldId, fieldValue, resumenHistorial) {
  try {
    // Primero obtener el ID del contacto
    const response = await axios.get(`${BITRIX24_API_URL}crm.contact.list?FILTER[PHONE]=%2B${phoneNumber}&SELECT[]=ID&SELECT[]=${fieldId}`);

    if (!response.data.result || response.data.result.length === 0) {
      console.log(`No se encontró contacto con número ${phoneNumber}`);
      return null;
    }

    const contactId = response.data.result[0].ID;
    const currentFieldValue = response.data.result[0][fieldId];

    // Verificar si el valor del campo es diferente al valor que se desea actualizar
    if (currentFieldValue === fieldValue) {
      console.log(`El campo ${fieldId} ya tiene el valor ${fieldValue}, no se actualizará.`);
      return null;  // No se realiza la actualización
    }

    const contactUpdateData = {
      id: contactId,
      fields: {
        [fieldId]: fieldValue
      }
    };

    const commentData = {
      fields: {
        "ENTITY_ID": contactId,
        "ENTITY_TYPE": "contact", // Asegúrate de que "contact" sea el valor correcto para ENTITY_TYPE
        "COMMENT": resumenHistorial,
        "AUTHOR_ID": 221, // Asegúrate de que 5 sea un ID de usuario válido y permitido
      }
    };

    const [updateResponse, commentResponse] = await Promise.all([
      axios.post(`${BITRIX24_API_URL}crm.contact.update`, contactUpdateData),
      axios.post(`${BITRIX24_API_URL}crm.timeline.comment.add`, commentData)
    ])

    console.log(`🔄 Contacto ${contactId} actualizado. Campo ${fieldId} establecido a ${fieldValue}`);
    return updateResponse.data.result;
  } catch (error) {
    console.error('Error al actualizar contacto en Bitrix24:', error.response?.data || error.message);
    throw error;
  }
}


const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Servidor escuchando en puerto ${PORT}`));