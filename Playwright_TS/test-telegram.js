require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

console.log('Testing Telegram connection...');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const chatId = process.env.TELEGRAM_CHAT_ID;

bot.sendMessage(chatId, '🧪 Test message from ticket automation system')
  .then(() => {
    console.log('✅ Telegram message sent successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Telegram error:', error.message);
    console.log('Please check:');
    console.log('1. Bot token is correct');
    console.log('2. Chat ID is correct');
    console.log('3. Bot has permission to send messages');
    process.exit(1);
  });
