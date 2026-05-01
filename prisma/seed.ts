import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Crear plantillas de bots
  const botTemplates = await prisma.botTemplate.createMany({
    data: [
      {
        name: 'Momentum Bot',
        description: 'Bot que sigue el momentum del mercado',
        strategy: 'momentum',
        price: 29.99,
        parameters: {
          timeframe: '1h',
          threshold: 0.05,
          riskPerTrade: 0.02,
        },
      },
      {
        name: 'Mean Reversion Bot',
        description: 'Bot que opera cuando el precio se desvía de la media',
        strategy: 'mean-reversion',
        price: 39.99,
        parameters: {
          timeframe: '4h',
          deviation: 2,
          riskPerTrade: 0.03,
        },
      },
      {
        name: 'Grid Trading Bot',
        description: 'Bot que ejecuta trading en grid automático',
        strategy: 'grid-trading',
        price: 49.99,
        parameters: {
          gridLevels: 10,
          gridSpacing: 0.02,
          riskPerTrade: 0.01,
        },
      },
      {
        name: 'Scalping Bot',
        description: 'Bot de scalping rápido con múltiples operaciones',
        strategy: 'scalping',
        price: 59.99,
        parameters: {
          timeframe: '15m',
          takeProfit: 0.005,
          stopLoss: 0.002,
        },
      },
    ],
  });

  console.log(`✅ Created ${botTemplates.count} bot templates`);

  console.log('✅ Database seeded successfully!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
