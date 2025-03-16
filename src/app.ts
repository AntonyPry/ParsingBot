import express from 'express';

const app = express();
app.use(express.json());

// Пример: проверочный роут
app.get('/', (req, res) => {
  res.send('Сервер работает');
});

export { app };