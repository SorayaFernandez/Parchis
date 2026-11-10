# ft_transcendence 🎮

<p align="center">
  <b>Real-time multiplayer web application built with React, TypeScript, Node.js, PostgreSQL and Docker</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/React-18-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React">
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-Backend-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/PostgreSQL-15-4169E1?style=for-the-badge&logo=postgresql&logoColor=white" alt="PostgreSQL">
  <img src="https://img.shields.io/badge/Docker-Compose-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker">
  <img src="https://img.shields.io/badge/42-Common%20Core-black?style=for-the-badge" alt="42">
</p>

---

**ft_transcendence** is a full-stack, real-time multiplayer web application developed as the final project of the **42 Madrid Common Core**.

The application combines a modern frontend, a RESTful backend, real-time WebSocket communication, persistent storage and a containerized infrastructure into a single application.

The main feature is an online multiplayer **Parchís** game supporting up to four players, surrounded by a complete web application with authentication, profiles, friends, matchmaking/lobbies, invitations, chat, presence and persistent game state.

The project was developed as a **team project**, requiring collaborative development, architectural decisions, frontend/backend integration and coordination between different parts of the system.

---

# 🎮 The Application

The application provides an interactive multiplayer environment where users can:

* Create and manage an account
* Authenticate securely
* Access their profile
* Manage friends
* Invite other players
* Join game lobbies
* Play multiplayer Parchís
* Communicate through chat
* See player presence and game state
* Reconnect to ongoing sessions
* Persist relevant application/game state
* Interact with the application in real time

The game supports **up to four players** and communicates game events between connected clients using WebSockets.

---

# 🏗️ Architecture

The application is composed of several services running in Docker containers:

```text
                         INTERNET / CLIENT
                                │
                                ▼
                    ┌──────────────────────┐
                    │        NGINX         │
                    │  HTTPS / Reverse     │
                    │       Proxy          │
                    │   ModSecurity + CRS  │
                    └──────────┬───────────┘
                               │
                  ┌────────────┴────────────┐
                  │                         │
                  ▼                         ▼
        ┌──────────────────┐       ┌──────────────────┐
        │     FRONTEND     │       │      BACKEND     │
        │                  │       │                  │
        │ React            │       │ Node.js          │
        │ TypeScript       │◄─────►│ Express          │
        │ Tailwind CSS     │ HTTP  │ REST API         │
        │ Zustand          │       │ Socket.IO        │
        │ React Router     │       │ JWT              │
        └──────────────────┘       └────────┬─────────┘
                                            │
                               ┌────────────┴────────────┐
                               │                         │
                               ▼                         ▼
                      ┌─────────────────┐       ┌─────────────────┐
                      │   PostgreSQL    │       │  HashiCorp Vault │
                      │                 │       │                 │
                      │ Persistent data │       │ Secrets / creds │
                      └─────────────────┘       └─────────────────┘
```

The services are connected through a dedicated Docker network and use Docker volumes for persistent data and infrastructure state.

---

# 🔄 Application Flow

A simplified request flow looks like:

```text
User
 │
 ▼
Browser
 │
 │ HTTPS
 ▼
NGINX
 │
 ├──────────────► Frontend
 │
 └──────────────► Backend
                       │
             ┌─────────┴─────────┐
             │                   │
             ▼                   ▼
         REST API           WebSocket
             │                   │
             ▼                   ▼
        PostgreSQL        Connected clients
```

HTTP requests are used for conventional application operations, while **Socket.IO/WebSockets** provide real-time communication for events that need to be synchronized immediately between clients.

---

# ⚛️ Frontend

The frontend is built with **React and TypeScript** and uses a component-based architecture.

### Main technologies

* React 18
* TypeScript
* Vite
* Tailwind CSS
* Zustand
* React Router
* Socket.IO Client
* i18next / react-i18next
* Framer Motion
* Canvas
* Howler
* Lucide React

These dependencies are defined in the project's frontend package configuration.

---

## 🎨 UI & UX

The interface was designed around a dark, game-oriented visual identity with a **glassmorphism** aesthetic and pastel/neon accents.

The frontend includes:

* Responsive layouts
* Interactive components
* Animated transitions
* Game HUD
* Dynamic game board
* Player interfaces
* Modals and overlays
* Notifications
* Chat interfaces
* Profile views
* Lobby interfaces
* Responsive game interactions

---

# 🧩 Frontend Architecture

The frontend separates application responsibilities into reusable React components and stateful modules.

A simplified conceptual structure is:

```text
                    React Application
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼
       Routing          UI Layer         State
          │                │                │
   React Router       Components         Zustand
          │                │                │
          └────────────────┼────────────────┘
                           │
                    Application Logic
                           │
             ┌─────────────┴─────────────┐
             │                           │
             ▼                           ▼
          REST API                  Socket.IO
             │                           │
             └─────────────┬─────────────┘
                           ▼
                         Backend
```

---

# 🎯 Game Interface

The game interface is responsible for rendering the current state of the Parchís match and providing an interactive experience for the players.

The frontend handles:

* Board rendering
* Player positions
* Piece states
* Game controls
* Turn information
* Game status
* Animations
* Player information
* Real-time updates

Canvas-based functionality is included in the frontend dependencies for graphical rendering.

---

# 🔌 Real-Time Communication

One of the central technical components of the project is real-time communication.

The application uses:

**Socket.IO**

on both sides:

```text
React
  │
  │ Socket.IO Client
  ▼
Node.js
  │
  │ Socket.IO
  ▼
Connected players
```

This allows the application to propagate events such as:

* Game actions
* Player movement
* Turn changes
* Lobby events
* Invitations
* Chat messages
* Presence changes
* Reconnection state
* Game synchronization

The backend uses `socket.io`, while the frontend uses `socket.io-client`.

---

# 🖥️ Backend

The backend is implemented with **Node.js and Express**.

### Technologies

* Node.js
* Express
* PostgreSQL
* Socket.IO
* JWT
* bcrypt
* CORS
* dotenv
* node-vault

These dependencies are defined in the backend project.

---

# 🌐 REST API

The backend exposes HTTP endpoints for operations that do not require persistent real-time communication.

The REST layer is responsible for application-level operations such as:

* Authentication
* User management
* Profiles
* Friends
* Game-related data
* Persistent application data

The backend is exposed internally through the Docker network and accessed through the NGINX gateway.

---

# 🔐 Authentication & Security

Authentication is implemented using **JWT-based authentication**, with passwords protected using **bcrypt**.

The application also includes an infrastructure-level security layer:

```text
                     Client
                       │
                     HTTPS
                       │
                       ▼
              ┌─────────────────┐
              │      NGINX      │
              │                 │
              │ TLS termination │
              │ ModSecurity     │
              │ OWASP CRS       │
              └────────┬────────┘
                       │
                       ▼
                    Backend
```

The NGINX container is based on an **OWASP ModSecurity CRS** image and is configured with TLS certificates and ModSecurity rules.

---

# 🛡️ ModSecurity & OWASP CRS

The reverse proxy uses:

* NGINX
* ModSecurity
* OWASP Core Rule Set

The NGINX Docker image copies the project's NGINX, ModSecurity and CRS configuration into the container and exposes HTTPS on port `443`.

The external Docker mapping exposes this service through:

```text
8443 → 443
```

allowing the application to be accessed through an HTTPS entry point.

---

# 🔑 Secrets Management

The project uses **HashiCorp Vault** to manage sensitive credentials.

The infrastructure includes two Vault-related services:

```text
vault
   │
   ▼
vault-init
   │
   ▼
credentials volume
   │
   ├──────────► PostgreSQL
   │
   └──────────► Backend
```

The PostgreSQL service reads its database password from a Vault-mounted credentials file, while the backend is configured to communicate with Vault through the Docker network.

This avoids treating application credentials as ordinary source-code configuration.

---

# 🗄️ Database

The application uses **PostgreSQL 15** as its relational database.

The database runs in its own container and stores persistent data using a Docker volume:

```text
PostgreSQL
     │
     ▼
db_data volume
```

The Compose configuration also includes a health check using `pg_isready` so dependent services can wait until PostgreSQL is ready.

---

# 🐳 Docker Architecture

The application is fully containerized.

The main services are:

| Service      | Responsibility                                      |
| ------------ | --------------------------------------------------- |
| `nginx`      | HTTPS entry point, reverse proxy and security layer |
| `frontend`   | React application                                   |
| `backend`    | Node.js / Express application and WebSockets        |
| `db`         | PostgreSQL database                                 |
| `vault`      | Secret management                                   |
| `vault-init` | Vault initialization                                |

The services communicate through a dedicated Docker network and use persistent volumes where required.

---

# 📦 Docker Compose

The infrastructure is orchestrated through:

```text
docker-compose.yml
```

The Compose configuration defines:

* Service dependencies
* Health checks
* Networks
* Persistent volumes
* Environment configuration
* Internal service communication
* Secret volumes
* Port mappings
* Container restart policies

For example, the backend waits for PostgreSQL and Vault initialization before starting.

---

# 🧱 Infrastructure Overview

```text
                    Docker Compose
                          │
        ┌─────────────────┼──────────────────┐
        │                 │                  │
        ▼                 ▼                  ▼
      NGINX             FRONTEND           BACKEND
        │                                      │
        │                                      │
        │                              ┌───────┴────────┐
        │                              │                │
        ▼                              ▼                ▼
    ModSecurity                     PostgreSQL       Vault
    OWASP CRS                          │                │
        │                              │                │
        └──────────────────────────────┴────────────────┘
                       Docker Network
```

---

# ⚙️ Makefile

The project includes a Makefile that acts as a convenient interface over Docker Compose.

Available commands include:

```bash
make
make up
make down
make restart
make logs
make logs-back
make logs-front
make clean
make fclean
make re
```

The Makefile uses Docker Compose to build, start, stop and reset the application infrastructure.

---

# 🚀 Getting Started

## Requirements

You need:

* Docker
* Docker Compose
* Git

---

## Clone the repository

```bash
git clone https://github.com/sorayaafdz/ft_transcendence.git
cd ft_transcendence
```

---

## Environment configuration

Create the required environment configuration according to the variables expected by the backend and Compose configuration.

> **Never commit real credentials, passwords, private keys or production secrets to the repository.**

---

## Start the application

The easiest way to start the complete infrastructure is:

```bash
make
```

or:

```bash
make up
```

The Makefile rebuilds and starts the Docker Compose stack in detached mode.

---

## Stop the application

```bash
make down
```

---

## Restart

```bash
make restart
```

---

## Logs

Database:

```bash
make logs
```

Backend:

```bash
make logs-back
```

Frontend:

```bash
make logs-front
```

---

## Full reset

```bash
make fclean
```

This stops the containers, removes Docker volumes and removes the backend `node_modules` directory.

To rebuild everything:

```bash
make re
```

These commands are defined directly in the repository's Makefile.

---

# 🌐 Accessing the Application

The NGINX service exposes HTTPS through:

```text
https://localhost:8443
```

The external port `8443` is mapped to the container's HTTPS port `443`.

---

# 📁 Project Structure

```text
ft_transcendence/
│
├── backend/
│   ├── ...
│   ├── Dockerfile
│   └── package.json
│
├── frontend/
│   ├── ...
│   ├── Dockerfile
│   └── package.json
│
├── nginx/
│   ├── Dockerfile
│   ├── nginx.conf
│   ├── modsecurity.conf
│   ├── crs-setup.conf
│   └── certs/
│
├── vault/
│   ├── config/
│   └── init-vault.sh
│
├── docker-compose.yml
├── Makefile
└── .env
```

The repository currently separates the application into dedicated `backend`, `frontend`, `nginx` and `vault` directories, alongside the Compose and Make configuration.

---

# 🔄 Data & Communication Flow

A typical authenticated application interaction can be represented as:

```text
                  ┌──────────────┐
                  │    Client    │
                  └──────┬───────┘
                         │
                      HTTPS
                         │
                         ▼
                  ┌──────────────┐
                  │    NGINX     │
                  │ ModSecurity  │
                  └──────┬───────┘
                         │
                         ▼
                  ┌──────────────┐
                  │   Backend    │
                  │ Node / API   │
                  └──────┬───────┘
                         │
                ┌────────┴────────┐
                │                 │
                ▼                 ▼
          PostgreSQL           Socket.IO
                │                 │
                │                 ▼
                │          Connected clients
                │
                ▼
          Persistent data
```

---

# 🧠 Key Engineering Challenges

## 1. Real-time state synchronization

A multiplayer game requires multiple clients to maintain a consistent view of the current game state.

The application therefore needs to coordinate:

* Player actions
* Turns
* Game state
* Connection state
* Lobby state
* Reconnection
* Presence
* Chat

WebSockets provide the persistent communication channel required for these interactions.

---

## 2. Frontend / backend integration

The application combines two different communication models:

```text
REST
 │
 ├── Authentication
 ├── Persistent operations
 └── Data management

WebSockets
 │
 ├── Game events
 ├── Chat
 ├── Presence
 └── Real-time synchronization
```

Choosing which operations belong to each communication model is an important architectural consideration.

---

## 3. Persistent multiplayer state

The application needs to maintain a distinction between:

```text
User / application state
          │
          ▼
       Database
          │
          │
          └──── persistent

Game / connection state
          │
          ▼
      WebSockets
          │
          └──── real-time
```

This separation allows persistent information to live in PostgreSQL while transient real-time events are propagated through Socket.IO.

---

## 4. Containerized infrastructure

The project is not simply a frontend and backend running locally.

It includes a complete multi-service environment:

```text
NGINX
Frontend
Backend
PostgreSQL
Vault
Vault initialization
ModSecurity
Docker networking
Persistent volumes
TLS
```

This required coordinating service dependencies, networking, volumes, health checks and startup order.

---

# 👩‍💻 My Role

This was a collaborative project developed as part of the 42 Common Core.

My primary responsibilities were focused on the **frontend and user experience**, including:

### Frontend Lead

* Frontend architecture
* React component development
* TypeScript
* UI/UX design
* Responsive interfaces
* Game interface
* Board and piece presentation
* HUD
* Interactive user experience
* Frontend/backend integration
* Real-time UI updates
* Application theming

I also worked on the coordination between frontend requirements and the rest of the application, helping integrate the interface with backend services and real-time communication.

---

# 🎨 Design

The visual identity was designed around a dark game environment with a **glassmorphism-inspired interface** and pastel/neon accents.

The UI combines:

```text
Dark interface
     +
Glassmorphism
     +
Pastel / neon accents
     +
Animations
     +
Interactive game elements
```

The goal was to create a consistent interface across the application while keeping the game experience visually clear.

---

# 🧰 Technology Stack

## Frontend

| Technology       | Purpose                           |
| ---------------- | --------------------------------- |
| React            | UI framework                      |
| TypeScript       | Type-safe application development |
| Vite             | Development/build tooling         |
| Tailwind CSS     | Styling                           |
| Zustand          | State management                  |
| React Router     | Client-side routing               |
| Socket.IO Client | Real-time communication           |
| i18next          | Internationalization              |
| Framer Motion    | Animations                        |
| Canvas           | Graphical rendering               |
| Howler           | Audio                             |
| Lucide React     | UI icons                          |

The current frontend dependency configuration confirms these technologies.

---

## Backend

| Technology | Purpose                       |
| ---------- | ----------------------------- |
| Node.js    | Runtime                       |
| Express    | HTTP API                      |
| PostgreSQL | Relational database           |
| Socket.IO  | WebSockets / real-time events |
| JWT        | Authentication                |
| bcrypt     | Password hashing              |
| CORS       | Cross-origin configuration    |
| dotenv     | Environment configuration     |
| node-vault | Vault integration             |

These dependencies are present in the current backend configuration.

---

## Infrastructure

| Technology      | Purpose                  |
| --------------- | ------------------------ |
| Docker          | Containerization         |
| Docker Compose  | Service orchestration    |
| NGINX           | Reverse proxy            |
| TLS             | HTTPS                    |
| ModSecurity     | Web application security |
| OWASP CRS       | Security rules           |
| HashiCorp Vault | Secret management        |
| PostgreSQL      | Persistent storage       |

The infrastructure is defined through the project's Docker Compose and NGINX configuration.

---

# 📊 Technical Overview

```text
┌───────────────────────────────────────────────────────┐
│                    FT_TRANSCENDENCE                   │
├───────────────────────────────────────────────────────┤
│                                                       │
│  FRONTEND                                             │
│  React · TypeScript · Tailwind · Zustand · Vite       │
│                                                       │
│                    │                                  │
│             REST / WebSockets                         │
│                    │                                  │
│                    ▼                                  │
│  BACKEND                                              │
│  Node.js · Express · Socket.IO · JWT                 │
│                                                       │
│             ┌──────┴──────┐                           │
│             │             │                           │
│             ▼             ▼                           │
│        PostgreSQL      HashiCorp Vault                │
│                                                       │
├───────────────────────────────────────────────────────┤
│  INFRASTRUCTURE                                       │
│  Docker · Compose · NGINX · TLS                      │
│  ModSecurity · OWASP CRS · Docker Network            │
└───────────────────────────────────────────────────────┘
```

---

# 📚 What I Learned

This project brought together many of the concepts developed throughout the 42 Common Core and applied them to a larger software system.

### Full-stack development

* Frontend architecture
* Backend APIs
* Database integration
* Client/server communication
* Real-time applications

### Real-time systems

* WebSockets
* Event-driven architecture
* Client synchronization
* Presence
* Reconnection
* Real-time state updates

### Software architecture

* Separation of frontend/backend responsibilities
* State management
* API design
* Service boundaries
* Modular application structure

### Security

* Authentication
* Password hashing
* JWT
* HTTPS/TLS
* Reverse proxies
* ModSecurity
* OWASP CRS
* Secret management

### DevOps

* Docker
* Docker Compose
* Container networking
* Persistent volumes
* Service dependencies
* Health checks
* Infrastructure configuration

### Team development

* Git workflows
* Collaborative development
* Frontend/backend integration
* Responsibility distribution
* Code integration
* Feature coordination

---

# 🎓 42 Common Core

**ft_transcendence** is the final major project of the **42 Madrid Common Core**.

It combines concepts from earlier projects into a complete application involving:

* Frontend development
* Backend development
* Databases
* Networking
* WebSockets
* Authentication
* Security
* Docker
* Infrastructure
* Team collaboration
* Software architecture

The project represents the transition from isolated programming exercises to the development of a larger, multi-service software system.

---

# 👩‍💻 Authors

Developed as a collaborative project at **42 Madrid**.

**Soraya Fernández**

GitHub: [@sorayaafdz](https://github.com/sorayaafdz)

---

# 📄 License

This project was developed as part of the 42 Madrid Common Core and is intended primarily for educational and portfolio purposes.

---

<p align="center">
  <b>From a multiplayer game to a complete full-stack system.</b>
</p>

<p align="center">
  <i>React · TypeScript · Node.js · PostgreSQL · WebSockets · Docker · NGINX · Vault</i>
</p>
