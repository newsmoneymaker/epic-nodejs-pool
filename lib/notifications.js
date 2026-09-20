/**
 * Заглушка: почтовые и Telegram-уведомления отключены.
 * Интерфейс сохранён, чтобы pool.js, api.js, blockUnlocker.js и
 * paymentProcessor.js работали без изменений.
 **/
exports.sendToAll = function (template, variables) {};
exports.sendToMiner = function (miner, template, variables) {};
exports.sendToEmail = function (email, template, variables) {};
exports.sendToTelegramChannel = function (template, variables) {};
