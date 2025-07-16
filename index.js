require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const axios = require("axios");
const { responderConPdf, obtenerResumenHistorial } = require("./consulta_empresa.js");
const sendMessage = require('./sendMessage.js')

const app = express();
app.use(cors());
app.use(express.json());

// Configuración de OpenAI (ChatGPT)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const OPENAI_API_URL = 'https://api.openai.com/v1/audio/transcriptions';

// Configuración de Bitrix24
const BITRIX24_API_URL = process.env.BITRIX24_API_URL;
const BITRIX24_LIST_FIELD_ID = process.env.BITRIX24_LIST_FIELD_ID || 'UF_CRM_1752006453';
const BITRIX24_LIST_VALUE = process.env.BITRIX24_LIST_VALUE || '2223'; // Yes
const BITRIX24_ADMIN_VALUE = process.env.BITRIX24_ADMIN_VALUE || '2225'; // Valor para Admin

app.get('/', async (req, res) => {
  return res.json({ message: 'Servidor corriendo' })
})

app.get('/send-message', async (req, res) => {

  sendMessage('Test desde la api', '584129253568')

  return res.json({ message: 'Mensaje enviado' })
})

app.post('/webhook', async (req, res) => {

  console.log('entró al webhook')

  try {
    const { messages } = req.body;

    if (!messages) {
      if (req.body.test) {
        console.log('Webhook conectado')
        return res.status(200).json({ status: 200 })
      }
      return console.log('No se recibió ningún mensaje')
    }

    let message = messages[0]
    const { chatId, type, sentFromApp, authorName, authorId, status } = message;

    if (chatId !== '19545480212') {
      console.log('chatId', chatId, 'Es diferente a 19545480212')
      return res.end()
    }

    // console.log('message', message)

    if (authorId && parseInt(authorId) > 0) {
      console.log(`🛠️ Mensaje de Admin recibido para ${chatId}`);

      try {
        const resumenHistorial = await obtenerResumenHistorial(chatId);
        console.log(`📜 Resumen profesional de la conversación con ${chatId}:\n`);
        console.log(resumenHistorial);
        console.log('\n' + '-'.repeat(50) + '\n'); // Separador visual

        await updateContactField(chatId, BITRIX24_LIST_FIELD_ID, BITRIX24_ADMIN_VALUE, resumenHistorial);
      } catch (error) {
        console.error('Error al procesar mensaje de admin:', error);
      }

      return res.status(200).end();
    }

    if (sentFromApp || status == 'read' || authorName === 'Admin') return

    let messageCustomer;

    // Caso 1: Mensaje de texto
    if (type === 'text') {
      const text = message.text;
      console.log(`📩 Mensaje de texto de ${chatId}: ${text}`);
      messageCustomer = text
      // Caso 2: Nota de voz (audio)
    } else if (type === 'audio') {
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
        messageCustomer = transcription
        console.log(`📝 Transcripción del audio: ${transcription}`);

        try {
          fs.unlinkSync(filePath);
          console.log(`🗑️ Audio eliminado: ${filePath}`);
        } catch (err) {
          console.error('Error al eliminar el archivo de audio:', err);
        }

      } catch (error) {
        console.error('Error al procesar el audio:', error.message);
      }
    }

    if (!messageCustomer) return

    // Verificar el contacto en Bitrix24 y el valor del campo específico
    const shouldRespond = await checkContactAndFieldValue(chatId);
    console.log('shouldRespond', shouldRespond)

    if (!shouldRespond) {
      console.log(`No se responderá al contacto ${chatId} (el campo no tiene el valor requerido o el contacto no existe)`);
      return res.status(200).end();
    }

    // Procesar mensaje solo si se debe responder
    const { respuesta } = await responderConPdf(messageCustomer, chatId);

    // Enviar respuesta
    // console.log('sendMessage(respuesta, chatId)', respuesta, chatId)
    // await sendMessage(respuesta, chatId)
    console.log(respuesta)

    // Crear nuevo contacto en Bitrix24 (si no existe)
    if (shouldRespond === 'create') {
      await createContactInBitrix24(chatId, authorName);
    }

    res.status(200).end();
  } catch (error) {
    console.error('Error en webhook:', error);
    res.status(500).json({ error: 'Ocurrió un error' });
  }
});

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

// Función para verificar contacto y valor del campo en Bitrix24
async function checkContactAndFieldValue(phoneNumber) {
  try {
    const response = await axios.get(`${BITRIX24_API_URL}crm.contact.list?FILTER[PHONE]=%2B${phoneNumber}&SELECT[]=ID&SELECT[]=${BITRIX24_LIST_FIELD_ID}`);

    // Si no hay contactos, debemos responder y crear uno nuevo
    if (!response.data.result || response.data.result.length === 0) {
      return 'create';
    }

    // Verificar el valor del campo en cada contacto encontrado
    for (const contact of response.data.result) {
      if (contact[BITRIX24_LIST_FIELD_ID] === BITRIX24_LIST_VALUE) {
        return true; // El campo tiene el valor correcto, debemos responder
      }
    }

    return false; // El contacto existe pero el campo no tiene el valor correcto
  } catch (error) {
    console.error('Error al verificar contacto en Bitrix24:', error.response?.data || error.message);
    throw error;
  }
}

// Función para crear un nuevo contacto en Bitrix24
async function createContactInBitrix24(phoneNumber, name) {
  try {
    const contactData = {
      NAME: name || 'Cliente WhatsApp',
      PHONE: [{ VALUE: `+${phoneNumber}`, VALUE_TYPE: 'WORK' }],
      [BITRIX24_LIST_FIELD_ID]: BITRIX24_LIST_VALUE // Asignar valor al campo de lista
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