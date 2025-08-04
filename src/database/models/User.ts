import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../index';

interface IUserAttributes {
	id: number;
	userId: number | null
	username: string | null;
}

interface IUserCreationAttributes extends Optional<IUserAttributes, 'id'> {}

export class User
	extends Model<IUserAttributes, IUserCreationAttributes>
	implements IUserAttributes
{
	public id!: number;
	public userId!: number;
	public username!: string | null;
}

User.init(
	{
		id: {
			type: DataTypes.INTEGER.UNSIGNED,
			autoIncrement: true,
			primaryKey: true,
		},
		userId: {
			type: DataTypes.BIGINT,
			allowNull: true,
			unique: true,
		},
		username: {
			type: DataTypes.STRING,
			allowNull: true,
		},
	},
	{
		sequelize,
		tableName: 'users',
		timestamps: true,
	}
);