import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../index';

interface IParsedDataAttributes {
  id: number;
  userId: number;
  dataContent: string;
  createdAt?: Date;
  updatedAt?: Date;
}

interface IParsedDataCreationAttributes extends Optional<IParsedDataAttributes, 'id'> {}

export class ParsedData
  extends Model<IParsedDataAttributes, IParsedDataCreationAttributes>
  implements IParsedDataAttributes {
  public id!: number;
  public userId!: number;
  public dataContent!: string;
  public createdAt!: Date;
  public updatedAt!: Date;
}

ParsedData.init(
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
    dataContent: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'parsed_data',
    timestamps: true,
  }
);