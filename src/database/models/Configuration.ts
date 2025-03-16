import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../index';

interface IConfigurationAttributes {
  id: number;
  userId: number;
  configData: string;
}

interface IConfigurationCreationAttributes extends Optional<IConfigurationAttributes, 'id'> {}

export class Configuration extends Model<IConfigurationAttributes, IConfigurationCreationAttributes>
  implements IConfigurationAttributes {
  public id!: number;
  public userId!: number;
  public configData!: string;
}

Configuration.init(
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    configData: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'configurations',
  }
);