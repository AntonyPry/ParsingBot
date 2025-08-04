'use strict';

module.exports = {
	async up(queryInterface, Sequelize) {
		// Индекс для быстрого поиска по username при авторизации
    await queryInterface.sequelize.query(
      'CREATE INDEX `idx_users_username` ON `users` (`username`)'
    );
	},

	async down(queryInterface, Sequelize) {
		await queryInterface.sequelize.query(
			'DROP INDEX `idx_users_username` ON `users`'
		);
	},
};
