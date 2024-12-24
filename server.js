const express = require('express');
const axios = require('axios');
const AdmZip = require('adm-zip');
const protobuf = require('protobufjs');
const cron = require('node-cron');
const cors = require('cors');
const Papa = require('papaparse');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

console.log('Démarrage du serveur...');

const GTFS_URL = 'https://data.montpellier3m.fr/TAM_MMM_GTFSRT/GTFS.zip';
const REALTIME_URL = 'https://data.montpellier3m.fr/TAM_MMM_GTFSRT/VehiclePosition.pb';

let staticSchedules = null;
let realtimeData = null;

async function loadStaticSchedules() {
    console.log('Tentative de chargement des horaires statiques...');
    try {
        const response = await axios.get(GTFS_URL, { responseType: 'arraybuffer' });
        console.log('Fichier GTFS téléchargé avec succès');
        
        const zip = new AdmZip(response.data);
        console.log('Fichier ZIP décompressé');
        
        const stopTimesEntry = zip.getEntry('stop_times.txt');
        const routesEntry = zip.getEntry('routes.txt');
        
        if (!stopTimesEntry || !routesEntry) {
            throw new Error('Fichiers GTFS manquants dans le ZIP');
        }

        console.log('Fichiers trouvés dans le ZIP');
        const stopTimes = stopTimesEntry.getData().toString('utf8');
        const routes = routesEntry.getData().toString('utf8');

        staticSchedules = parseGTFSData(stopTimes, routes);
        console.log('Données GTFS mises à jour avec succès');
    } catch (error) {
        console.error('Erreur lors du chargement des données GTFS:', error.message);
    }
}

async function loadRealtimeData() {
    console.log('Tentative de chargement des données temps réel...');
    try {
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
    }
}

function parseGTFSData(stopTimes, routes) {
    console.log('Parsing des données GTFS...');
    try {
        const parsedStopTimes = Papa.parse(stopTimes, { 
            header: true, 
            skipEmptyLines: true,
            dynamicTyping: true 
        }).data;

        console.log('Échantillon des données parsées:', parsedStopTimes.slice(0, 5));
        console.log('Nombre total de stop times:', parsedStopTimes.length);

        // Voir tous les stop_id uniques pour vérifier
        const uniqueStopIds = [...new Set(parsedStopTimes.map(trip => trip.stop_id))];
        console.log('Stop IDs uniques:', uniqueStopIds);

        // Filtrer avec des logs
        const filteredTrips = parsedStopTimes.filter(trip => {
            if (trip.stop_id === 264) {
                console.log('Trouvé trip pour stop_id 264:', trip);
            }
            return trip.stop_id === 264 && trip.stop_sequence === 1;
        });

        console.log(`Nombre total d'horaires trouvés pour l'arrêt Vert-Bois:`, filteredTrips.length);
        if (filteredTrips.length > 0) {
            console.log('Premier horaire trouvé:', filteredTrips[0]);
        }

        const result = {
            routeId: '4-13',
            routeName: 'Vert-Bois → Université',
            stopTimes: filteredTrips.map(trip => ({
                departure_time: trip.departure_time,
                arrival_time: trip.arrival_time,
                trip_id: trip.trip_id,
                stop_sequence: trip.stop_sequence,
                scheduled_time: trip.departure_time
            }))
        };

        console.log('Résultat final:', result);
        return result;

    } catch (error) {
        console.error('Erreur détaillée lors du parsing GTFS:', error);
        console.error('Stack:', error.stack);
        return [];
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
                    const vehicleInfo = {
                        timestamp: entity.vehicle.timestamp,
                        delay: entity.vehicle.delay || 0,
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
        const currentTime = now.toLocaleTimeString('fr-FR', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });

        const relevantStopTimes = staticData.stopTimes.filter(stopTime => 
            stopTime.departure_time >= currentTime
        );

        relevantStopTimes.sort((a, b) => 
            a.departure_time.localeCompare(b.departure_time)
        );

        const combinedData = relevantStopTimes.map(stopTime => {
            const realtime = realtimeData[stopTime.trip_id] || {};
            const delay = realtime.delay || 0;
            
            // Calculer l'heure réelle en tenant compte du retard
            let [hours, minutes, seconds] = stopTime.departure_time.split(':').map(Number);
            let totalMinutes = hours * 60 + minutes + Math.floor(delay / 60);
            let realHours = Math.floor(totalMinutes / 60);
            let realMinutes = totalMinutes % 60;

            return {
                scheduled_time: stopTime.departure_time, // Horaire théorique
                departure_time: `${realHours.toString().padStart(2, '0')}:${realMinutes.toString().padStart(2, '0')}:00`, // Horaire temps réel
                realtime: {
                    delay: delay,
                    status: realtime.currentStatus || 'SCHEDULED',
                    lastUpdate: realtime.timestamp ? new Date(realtime.timestamp * 1000).toISOString() : null
                }
            };
        });

        return combinedData;
    } catch (error) {
        console.error('Erreur lors de la combinaison des données:', error);
        return [];
    }
}

app.get('/api/schedule', (req, res) => {
    console.log('Requête reçue sur /api/schedule');
    if (!staticSchedules || !realtimeData) {
        console.log('Données manquantes:', {
            staticSchedules: !!staticSchedules,
            realtimeData: !!realtimeData
        });
        return res.status(503).json({ error: 'Données non disponibles' });
    }

    const combinedData = combineStaticAndRealtime(staticSchedules, realtimeData);
    console.log('Données à envoyer:', combinedData);
    res.json(combinedData);
});

Promise.all([loadStaticSchedules(), loadRealtimeData()]).then(() => {
    console.log('Chargement initial terminé');
    app.listen(PORT, () => {
        console.log(`Serveur démarré sur le port ${PORT}`);
    });
}).catch(error => {
    console.error('Erreur lors du chargement initial:', error);
});

cron.schedule('0 4 * * *', () => {
    console.log('Mise à jour quotidienne des données statiques...');
    loadStaticSchedules();
});

cron.schedule('*/30 * * * * *', () => {
    console.log('Mise à jour des données temps réel...');
    loadRealtimeData();
});

console.log('Configuration du serveur terminée');