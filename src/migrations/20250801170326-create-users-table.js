'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('users', {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false,
      },
      // Уникальный ID пользователя в Telegram
      userId: {
        type: Sequelize.BIGINT,
        allowNull: true,
        unique: true,
      },
      // Его username для удобства отображения
      username: {
        type: Sequelize.STRING,
        allowNull: true, // username может отсутствовать у пользователя
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn('NOW'),
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn('NOW'),
      },
    });
  },
  
  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('users');
  },
};