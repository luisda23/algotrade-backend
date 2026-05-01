# Trading Bot App - Backend

Backend para la app de trading bots con autenticación, base de datos, pagos con Stripe y sincronización con brokers.

## 🚀 Instalación

### Requisitos previos
- Node.js 18+
- PostgreSQL 14+
- Stripe account (para pagos)

### 1. Instalar dependencias
```bash
npm install
```

### 2. Configurar variables de entorno
```bash
cp .env.example .env
# Edita .env con tus valores
```

### 3. Configurar base de datos
```bash
# Crear la base de datos
createdb trading_bot_db

# Ejecutar migraciones
npm run prisma:migrate
```

### 4. Generar cliente Prisma
```bash
npm run prisma:generate
```

### 5. Iniciar el servidor
```bash
npm run dev
```

El servidor estará corriendo en `http://localhost:5000`

## 📚 Endpoints principales

### Autenticación
- `POST /api/auth/signup` - Crear usuario
- `POST /api/auth/login` - Login
- `GET /api/auth/me` - Obtener perfil actual

### Bots
- `GET /api/bots` - Obtener todos los bots del usuario
- `POST /api/bots` - Crear nuevo bot
- `GET /api/bots/:botId` - Obtener detalle del bot
- `PUT /api/bots/:botId` - Actualizar bot
- `DELETE /api/bots/:botId` - Eliminar bot

### Brokers
- `POST /api/brokers/connect` - Conectar un broker
- `GET /api/brokers` - Obtener conexiones de brokers
- `DELETE /api/brokers/:connectionId` - Desconectar broker

### Marketplace
- `GET /api/marketplace/templates` - Obtener todas las plantillas
- `GET /api/marketplace/templates/:templateId` - Obtener detalle
- `POST /api/marketplace/buy` - Comprar un bot

### Pagos
- `POST /api/payments/checkout` - Crear sesión de Stripe
- `POST /api/payments/webhook` - Webhook de Stripe

## 🗄️ Base de datos

Esquema Prisma en `prisma/schema.prisma`:
- Users
- Bots
- BotTemplates (marketplace)
- BrokerConnections
- Trades
- Subscriptions

Ver esquema en Prisma Studio:
```bash
npm run prisma:studio
```

## 🔐 Seguridad

- ✅ Contraseñas hasheadas con bcryptjs
- ✅ JWT para autenticación
- ⚠️ TODO: Encriptar API keys de brokers
- ⚠️ TODO: Rate limiting
- ⚠️ TODO: Validación de entrada mejorada

## 📦 Deployment

Construir para producción:
```bash
npm run build
npm start
```

## 🛠️ Próximos pasos

1. Integración con APIs de brokers (Binance, Interactive Brokers, etc.)
2. Encriptación de API keys
3. Sistema de notificaciones
4. Dashboard de trading real
5. Testing automatizado
