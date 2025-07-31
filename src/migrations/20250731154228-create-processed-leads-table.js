'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('processed_leads', {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false,
      },
      // Уникальный номер заключения для поиска в кеше
      conclusionNumber: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true,
      },
      // Готовый текст сообщения от AI
      processedMessage: {
        type: Sequelize.TEXT,
        allowNull: false,
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
    await queryInterface.dropTable('processed_leads');
  },
};