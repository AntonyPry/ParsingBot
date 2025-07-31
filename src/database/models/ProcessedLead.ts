import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../index';

interface IProcessedLeadAttributes {
	id: number;
	conclusionNumber: string;
	processedMessage: string;
}

interface IProcessedLeadCreationAttributes
	extends Optional<IProcessedLeadAttributes, 'id'> {}

export class ProcessedLead
	extends Model<IProcessedLeadAttributes, IProcessedLeadCreationAttributes>
	implements IProcessedLeadAttributes
{
	public id!: number;
	public conclusionNumber!: string;
	public processedMessage!: string;
}

ProcessedLead.init(
	{
		id: {
			type: DataTypes.INTEGER.UNSIGNED,
			autoIncrement: true,
			primaryKey: true,
		},
		conclusionNumber: {
			type: DataTypes.STRING,
			allowNull: false,
			unique: true,
		},
		processedMessage: {
			type: DataTypes.TEXT,
			allowNull: false,
		},
	},
	{
		sequelize,
		tableName: 'processed_leads',
		timestamps: true,
	}
);