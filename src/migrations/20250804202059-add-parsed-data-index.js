'use strict';

module.exports = {
	async up(queryInterface, Sequelize) {
		// Составной индекс для оптимизации основного запроса планировщика
		// Используем префикс для поля TEXT и добавляем userId
    await queryInterface.sequelize.query(
      'CREATE INDEX `idx_parsed_data_content_user` ON `parsed_data` (`dataContent`(255), `userId`)'
    );
	},

	async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(
      'DROP INDEX `idx_parsed_data_content_user` ON `parsed_data`'
    );
	},
};
