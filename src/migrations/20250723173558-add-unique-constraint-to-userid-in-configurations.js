'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Добавляем уникальный индекс к колонке userId в таблице configurations
    await queryInterface.addConstraint('configurations', {
      fields: ['userId'],
      type: 'unique',
      name: 'unique_userId_constraint', // Имя для нашего ограничения
    });
  },
  
  async down(queryInterface, Sequelize) {
    // Эта функция нужна для отката миграции. Она удаляет созданный индекс.
    await queryInterface.removeConstraint('configurations', 'unique_userId_constraint');
  }
};