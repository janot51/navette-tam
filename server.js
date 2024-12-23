const express = require('express');
const axios = require('axios');
const AdmZip = require('adm-zip');
const protobuf = require('protobufjs');
const cron = require('node-cron');
const fs = require('fs/promises');
const Papa = require('papaparse');

const app = express();
const PORT = process.env.PORT || 3001;

const cors = require('cors');
app.use(cors());

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
  });

console.log('Démarrage du serveur...');

// URLs des données TAM
const GTFS_URL = 'https://data.montpellier3m.fr/TAM_MMM_GTFSRT/GTFS.zip';
const REALTIME_URL = 'https://data.montpellier3m.fr/TAM_MMM_GTFSRT/VehiclePosition.pb';

// Cache pour les données
let staticSchedules = null;
let realtimeData = null;

// Chargement et parsing du fichier GTFS
async function loadStaticSchedules() {
  console.log('Tentative de chargement des horaires statiques...');
  try {
    console.log('Téléchargement du fichier GTFS depuis:', GTFS_URL);
    const response = await axios.get(GTFS_URL, { responseType: 'arraybuffer' });
    console.log('Fichier GTFS téléchargé avec succès');
    
    const zip = new AdmZip(response.data);
    console.log('Fichier ZIP décompressé');
    
    // Extraire stop_times.txt et routes.txt
    const stopTimesEntry = zip.getEntry('stop_times.txt');
    const routesEntry = zip.getEntry('routes.txt');
    
    if (!stopTimesEntry || !routesEntry) {
      throw new Error('Fichiers GTFS manquants dans le ZIP');
    }

    console.log('Fichiers trouvés dans le ZIP');
    const stopTimes = stopTimesEntry.getData().toString('utf8');
    const routes = routesEntry.getData().toString('utf8');

    // Filtrer pour la navette A
    staticSchedules = parseGTFSData(stopTimes, routes);
    
    console.log('Données GTFS mises à jour avec succès');
  } catch (error) {
    console.error('Erreur lors du chargement des données GTFS:', error.message);
    if (error.response) {
      console.error('Statut de la réponse:', error.response.status);
      console.error('Headers:', error.response.headers);
    }
  }
}

// Chargement et parsing des données temps réel
async function loadRealtimeData() {
  console.log('Tentative de chargement des données temps réel...');
  try {
    console.log('Téléchargement des données temps réel depuis:', REALTIME_URL);
    const response = await axios.get(REALTIME_URL, { responseType: 'arraybuffer' });
    console.log('Données temps réel téléchargées avec succès');
    
    const root = await protobuf.load('gtfs-realtime.proto');
    console.log('Fichier proto chargé');
    
    const FeedMessage = root.lookupType('transit_realtime.FeedMessage');
    const message = FeedMessage.decode(new Uint8Array(response.data));
    console.log('Message protobuf décodé');
    
    realtimeData = processRealtimeData(message);
    console.log('Données temps réel traitées avec succès');
  } catch (error) {
    console.error('Erreur lors du chargement des données temps réel:', error.message);
    if (error.response) {
      console.error('Statut de la réponse:', error.response.status);
      console.error('Headers:', error.response.headers);
    }
  }
}

// Endpoint pour obtenir les horaires combinés
app.get('/api/schedule', (req, res) => {
  console.log('Requête reçue sur /api/schedule');
  if (!staticSchedules || !realtimeData) {
    console.log('Données non disponibles');
    return res.status(503).json({ error: 'Données non disponibles' });
  }

  const combinedData = combineStaticAndRealtime(staticSchedules, realtimeData);
  console.log('Données combinées envoyées');
  res.json(combinedData);
});

// Fonctions utilitaires
function parseGTFSData(stopTimes, routes) {
    console.log('Parsing des données GTFS...');
    try {
        // Parser les fichiers CSV
        const parsedStopTimes = Papa.parse(stopTimes, { header: true, skipEmptyLines: true }).data;
        const parsedRoutes = Papa.parse(routes, { header: true, skipEmptyLines: true }).data;

        // Trouver la Navette A avec son ID exact
        const navetteARoute = parsedRoutes.find(route => route.route_id === '4-13');

        if (!navetteARoute) {
            console.log('Navette A (ID: 4-13) non trouvée dans les routes');
            return {};
        }

        console.log('Navette A trouvée:', navetteARoute.route_long_name);

        // Filtrer les horaires pour la Navette A
        const navetteAStopTimes = parsedStopTimes.filter(stopTime => 
            stopTime.trip_id.startsWith('4-13')
        );

        // Afficher quelques informations utiles
        if (navetteAStopTimes.length > 0) {
            console.log(`Trouvé ${navetteAStopTimes.length} horaires pour la Navette A`);
            console.log('Premier horaire:', navetteAStopTimes[0]);
            console.log('Dernier horaire:', navetteAStopTimes[navetteAStopTimes.length - 1]);
        }

        return {
            routeId: '4-13',
            routeName: navetteARoute.route_long_name,
            stopTimes: navetteAStopTimes
        };
    } catch (error) {
        console.error('Erreur lors du parsing GTFS:', error);
        return {};
    }
}

function processRealtimeData(feedMessage) {
    console.log('Processing des données temps réel...');
    try {
        const updates = {};
        const feed = feedMessage.toJSON();

        if (feed.entity) {
            feed.entity.forEach(entity => {
                if (entity.vehicle) {
                    // Stocker les informations du véhicule
                    const vehicleInfo = {
                        timestamp: entity.vehicle.timestamp,
                        stopId: entity.vehicle.stopId,
                        currentStatus: entity.vehicle.currentStatus,
                        vehicleId: entity.vehicle.vehicle?.id
                    };

                    if (entity.vehicle.trip) {
                        updates[entity.vehicle.trip.tripId] = vehicleInfo;
                    }
                }
            });
        }

        console.log(`Traité ${Object.keys(updates).length} mises à jour temps réel`);
        return updates;
    } catch (error) {
        console.error('Erreur lors du traitement temps réel:', error);
        return {};
    }
}

function combineStaticAndRealtime(staticData, realtimeData) {
    console.log('Combinaison des données...');
    try {
        const now = new Date();
        const twoHoursLater = new Date(now.getTime() + 2 * 60 * 60 * 1000);

        // Filtrer les horaires pour les 2 prochaines heures
        const relevantStopTimes = staticData.stopTimes.filter(stopTime => {
            const stopTimeDate = new Date(stopTime.arrival_time);
            return stopTimeDate >= now && stopTimeDate <= twoHoursLater;
        });

        // Ajouter les informations temps réel
        const combinedData = relevantStopTimes.map(stopTime => {
            const realtimeInfo = realtimeData[stopTime.trip_id] || {};
            return {
                ...stopTime,
                realtime: {
                    delay: realtimeInfo.delay || 0,
                    status: realtimeInfo.currentStatus || 'SCHEDULED',
                    lastUpdate: realtimeInfo.timestamp
                }
            };
        });

        console.log(`Données combinées pour ${combinedData.length} arrêts`);
        return combinedData;
    } catch (error) {
        console.error('Erreur lors de la combinaison des données:', error);
        return [];
    }
}

// Chargement initial des données
console.log('Démarrage du chargement initial des données...');
Promise.all([loadStaticSchedules(), loadRealtimeData()]).then(() => {
  console.log('Chargement initial terminé');
  app.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
  });
}).catch(error => {
  console.error('Erreur lors du chargement initial:', error);
});

// Mettre à jour les données statiques quotidiennement
cron.schedule('0 4 * * *', () => {
  console.log('Mise à jour quotidienne des données statiques...');
  loadStaticSchedules();
});

// Mettre à jour les données temps réel toutes les 30 secondes
cron.schedule('*/30 * * * * *', () => {
  console.log('Mise à jour des données temps réel...');
  loadRealtimeData();
});

console.log('Configuration du serveur terminée');