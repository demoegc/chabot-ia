const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

class WazzupAPI {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.wazzup24.com/v3/message';
    this.headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json'
    };
  }

  /**
   * Envía un mensaje a través de la API de Wazzup24
   * @param {Object} params - Parámetros del mensaje
   * @param {string} params.channelId - ID del canal (UUIDv4)
   * @param {string} params.chatType - Tipo de chat (whatsapp, viber, whatsgroup, instagram, telegram)
   * @param {string} [params.chatId] - ID del chat (opcional para Telegram si se usa username/phone)
   * @param {string} [params.text] - Texto del mensaje
   * @param {string} [params.contentUri] - URL del archivo a enviar
   * @param {string} [params.refMessageId] - ID del mensaje a citar
   * @param {string} [params.crmUserId] - ID de usuario en el CRM
   * @param {string} [params.crmMessageId] - ID del mensaje en el CRM
   * @param {string} [params.username] - Para Telegram: nombre de usuario sin @
   * @param {string} [params.phone] - Para Telegram: número de teléfono
   * @param {boolean} [params.clearUnanswered] - Resetear contador de no respondidos
   * @param {string} [params.templateId] - ID de plantilla WABA
   * @param {Array} [params.templateValues] - Valores para variables de plantilla
   * @param {Object} [params.buttonsObject] - Objeto con botones para el mensaje
   * @returns {Promise<Object>} - Respuesta de la API
   */
  async sendMessage(params) {
    // Validar parámetros requeridos
    if (!params.channelId || !params.chatType) {
      throw new Error('channelId y chatType son parámetros requeridos');
    }

    if (!params.chatId && !(params.username || params.phone) && params.chatType === 'telegram') {
      throw new Error('Para Telegram, se requiere chatId o (username/phone)');
    }

    if (!params.text && !params.contentUri) {
      throw new Error('Se debe proporcionar text o contentUri');
    }

    if (params.text && params.contentUri) {
      throw new Error('No se pueden enviar text y contentUri al mismo tiempo');
    }

    try {
      const response = await axios.post(this.baseUrl, params, {
        headers: this.headers
      });

      return response.data;
    } catch (error) {
      if (error.response) {
        // La API respondió con un código de error
        const errorData = error.response.data;
        throw new Error(`Error ${error.response.status}: ${errorData.error || 'Unknown error'} - ${errorData.description || 'No description'}`);
      } else if (error.request) {
        // La solicitud fue hecha pero no hubo respuesta
        throw new Error('No se recibió respuesta del servidor de Wazzup24');
      } else {
        // Error al configurar la solicitud
        throw new Error(`Error al configurar la solicitud: ${error.message}`);
      }
    }
  }
}

// Ejemplo de uso
const sendMessage = async (message, CHAT_ID, trackingNumber) => {
  // Configuración
  let API_KEY;
  let CHANNEL_ID;
  if (trackingNumber == '561') {
    API_KEY = '388c6743795c43b497b5408a617bec2d';
    CHANNEL_ID = '37e572a1-a8ec-460e-b71a-881f831ca905';
  }
  else {
    API_KEY = '388c6743795c43b497b5408a617bec2d';
    CHANNEL_ID = 'ffc12f3b-a97f-4471-ac36-ce18458da455';
  }
  const CHAT_TYPE = 'whatsapp'; // whatsapp, viber, whatsgroup, instagram, telegram

  // Crear instancia de la API
  const wazzup = new WazzupAPI(API_KEY);

  try {
    // Ejemplo 1: Mensaje simple de texto
    const response = await wazzup.sendMessage({
      channelId: CHANNEL_ID,
      chatType: CHAT_TYPE,
      chatId: CHAT_ID,
      text: message,
      crmMessageId: uuidv4() // ID único para evitar duplicados
    });
    console.log('Mensaje enviado con éxito:', response);

  } catch (error) {
    console.error('Error al enviar el mensaje:', error.message);
  }
}

module.exports = sendMessage
