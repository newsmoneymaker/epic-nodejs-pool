/**
 * Заглушка: у Epic Cash нет котировок в источниках оригинального пула.
 * Вызывающий код (api.js, charts.js) корректно обрабатывает пустой ответ.
 **/
exports.get = function (source, tickers, callback) {
	callback([]);
};
