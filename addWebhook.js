const axios = require('axios');

// Configuración
const API_URL = 'https://api.wazzup24.com/v3/webhooks';
const API_KEY = '388c6743795c43b497b5408a617bec2d'; // Reemplaza con tu API Key real
const WEBHOOK_URI = 'https://b658f8bcb1f9.ngrok-free.app/webhook'; // Tu URL de webhook

// Datos para configurar el webhook
const payload = {
  webhooksUri: WEBHOOK_URI,
  subscriptions: {
    messagesAndStatuses: true,    // Mensajes y estados
    contactsAndOffers: true      // Creación de contactos y ofertas
  }
};

// Headers
const headers = {
  'Authorization': `Bearer ${API_KEY}`,
  'Content-Type': 'application/json'
};

// Función para configurar el webhook
async function configureWebhook() {
  try {
    const response = await axios.patch(API_URL, payload, { headers });
    console.log('✅ Webhook configurado:', response.data);
  } catch (error) {
    console.error('❌ Error al configurar el webhook:', error.response?.data || error.message);
  }
}

// Ejecutar
configureWebhook();

async function getWebhookStatus() {
  try {
    const response = await axios.get(API_URL, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Accept': 'application/json'
      }
    });
    console.log('✅ Estado del webhook:', response.data);
  } catch (error) {
    console.error('❌ Error al obtener el estado:', error.response?.data || error.message);
  }
}

// getWebhookStatus();
