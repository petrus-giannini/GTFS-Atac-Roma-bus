// Variabili globali
let map, busMarkers = [], stopMarkers = [], routePolylines = [];
let allVehicles = [], availableRoutes = [], tripUpdates = {};
let gtfsData = { stops: {}, routes: {}, trips: {}, shapes: {}, routeStops: {} };
let userLocation = null, viewportMode = false;

// URL dei feed ATAC
const VEH_URL = 'https://dati.comune.roma.it/catalog/dataset/a7dadb4a-66ae-4eff-8ded-a102064702ba/resource/d2b123d6-8d2d-4dee-9792-f535df3dc166/download/rome_vehicle_positions.pb';
const TRP_URL = 'https://dati.comune.roma.it/catalog/dataset/a7dadb4a-66ae-4eff-8ded-a102064702ba/resource/bf7577b5-ed26-4f50-a590-38b8ed4d2827/download/rome_trip_updates.pb';

// Schema Protocol Buffer per GTFS-RT
const GTFS_RT_PROTO = `
syntax = "proto2";
package transit_realtime;

message FeedMessage {
    required FeedHeader header = 1;
    repeated FeedEntity entity = 2;
}

message FeedHeader {
    required string gtfs_realtime_version = 1;
    optional uint64 timestamp = 3;
}

message FeedEntity {
    required string id = 1;
    optional TripUpdate trip_update = 3;
    optional VehiclePosition vehicle = 4;
}

message VehiclePosition {
    optional TripDescriptor trip = 1;
    optional VehicleDescriptor vehicle = 8;
    optional Position position = 2;
    optional uint64 timestamp = 5;
}

message TripUpdate {
    required TripDescriptor trip = 1;
    repeated StopTimeUpdate stop_time_update = 2;
}

message StopTimeUpdate {
    optional string stop_id = 4;
    optional StopTimeEvent arrival = 2;
}

message StopTimeEvent {
    optional int64 time = 2;
}

message Position {
    required float latitude = 1;
    required float longitude = 2;
    optional float bearing = 3;
}

message TripDescriptor {
    optional string trip_id = 1;
    optional string route_id = 5;
}

message VehicleDescriptor {
    optional string id = 1;
    optional string label = 2;
}
`;

// Inizializzazione app
window.addEventListener('load', () => {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            pos => {
                userLocation = [pos.coords.latitude, pos.coords.longitude];
                if (map) map.setView(userLocation, 15);
            },
            () => initMap()
        );
    } else {
        initMap();
    }
    setTimeout(initMap, 1000);
});

// Inizializza mappa
function initMap() {
    if (map) return;
    
    map = L.map('map').setView(userLocation || [41.9028, 12.4964], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap',
        maxZoom: 19
    }).addTo(map);

    // Event listeners
    document.getElementById('refreshBtn').addEventListener('click', loadVehiclePositions);
    document.getElementById('searchBtn').addEventListener('click', performSearch);
    document.getElementById('showViewportStops').addEventListener('click', showViewportStops);
    document.getElementById('routeFilter').addEventListener('keypress', e => {
        if (e.key === 'Enter') performSearch();
    });
    document.getElementById('routeFilter').addEventListener('input', handleAutocomplete);
    
    ['showBuses', 'showStops', 'showRoutes'].forEach(id => {
        document.getElementById(id).addEventListener('change', updateMap);
    });

    document.addEventListener('click', e => {
        if (!e.target.closest('.filter-section')) {
            document.getElementById('autocompleteList').style.display = 'none';
        }
    });

    map.on('moveend', () => {
        if (viewportMode) updateMap();
    });

    loadGTFS();
}

// Toggle controlli
function toggleControls() {
    const ctrl = document.querySelector('.controls');
    ctrl.classList.toggle('collapsed');
    document.getElementById('controlsToggle').textContent = 
        ctrl.classList.contains('collapsed') ? '▶' : '▼';
}

// Toggle legenda
function toggleLegend() {
    const leg = document.querySelector('.legend');
    leg.classList.toggle('collapsed');
    document.getElementById('legendToggle').textContent = 
        leg.classList.contains('collapsed') ? '▶' : '▼';
}

// Autocomplete
function handleAutocomplete() {
    const input = document.getElementById('routeFilter').value.toUpperCase();
    const list = document.getElementById('autocompleteList');
    
    if (!input) {
        list.style.display = 'none';
        return;
    }

    const matches = availableRoutes.filter(r => 
        r.toUpperCase().startsWith(input)
    ).slice(0, 10);

    if (matches.length) {
        list.innerHTML = matches.map(r => 
            `<div class="autocomplete-item" onclick="selectRoute('${r}')">${r}</div>`
        ).join('');
        list.style.display = 'block';
    } else {
        list.style.display = 'none';
    }
}

// Seleziona linea da autocomplete
function selectRoute(route) {
    document.getElementById('routeFilter').value = route;
    document.getElementById('autocompleteList').style.display = 'none';
    performSearch();
}

// Esegui ricerca
function performSearch() {
    viewportMode = false;
    document.getElementById('showBuses').checked = true;
    updateMap();
}

// Mostra fermate in vista
function showViewportStops() {
    viewportMode = true;
    document.getElementById('routeFilter').value = '';
    document.getElementById('showStops').checked = true;
    updateMap();
}

// Ricerca da popup fermata
function searchFromPopup(route) {
    document.getElementById('routeFilter').value = route;
    viewportMode = false;
    document.getElementById('showBuses').checked = true;
    updateMap();
}

// Carica dati GTFS statici
async function loadGTFS() {
    const status = document.getElementById('statusGTFS');
    
    try {
        status.className = 'status loading';
        status.textContent = 'Caricamento GTFS...';

        // Carica file in parallelo
        const [stopsRes, routesRes, tripsRes, shapesRes, routeStopsRes] = await Promise.all([
            fetch('stops.txt'),
            fetch('routes.txt'),
            fetch('trips.txt'),
            fetch('shapes.txt'),
            fetch('route_stops.json')
        ]);

        if (!stopsRes.ok || !routesRes.ok || !tripsRes.ok || !shapesRes.ok || !routeStopsRes.ok) {
            throw new Error('File GTFS mancanti');
        }

        const [stopsText, routesText, tripsText, shapesText, routeStopsJson] = await Promise.all([
            stopsRes.text(),
            routesRes.text(),
            tripsRes.text(),
            shapesRes.text(),
            routeStopsRes.json()
        ]);

        // Parse stops
        status.textContent = 'Parsing fermate...';
        Papa.parse(stopsText, { header: true, skipEmptyLines: true }).data.forEach(stop => {
            if (stop.stop_id && stop.stop_lat && stop.stop_lon) {
                gtfsData.stops[stop.stop_id] = {
                    id: stop.stop_id,
                    code: stop.stop_code || 'N/D',
                    name: stop.stop_name,
                    lat: parseFloat(stop.stop_lat),
                    lon: parseFloat(stop.stop_lon)
                };
            }
        });

        // Parse routes
        status.textContent = 'Parsing linee...';
        Papa.parse(routesText, { header: true, skipEmptyLines: true }).data.forEach(route => {
            if (route.route_id) {
                gtfsData.routes[route.route_id] = {
                    id: route.route_id,
                    shortName: route.route_short_name,
                    longName: route.route_long_name
                };
                if (route.route_short_name) {
                    availableRoutes.push(route.route_short_name);
                }
            }
        });
        availableRoutes = [...new Set(availableRoutes)].sort();

        // Parse trips
        status.textContent = 'Parsing viaggi...';
        Papa.parse(tripsText, { header: true, skipEmptyLines: true }).data.forEach(trip => {
            if (trip.trip_id) {
                gtfsData.trips[trip.trip_id] = {
                    id: trip.trip_id,
                    routeId: trip.route_id,
                    headsign: trip.trip_headsign,
                    shapeId: trip.shape_id
                };
            }
        });

        // Parse shapes
        status.textContent = 'Parsing tracciati...';
        Papa.parse(shapesText, { header: true, skipEmptyLines: true }).data.forEach(point => {
            if (point.shape_id && point.shape_pt_lat && point.shape_pt_lon) {
                if (!gtfsData.shapes[point.shape_id]) {
                    gtfsData.shapes[point.shape_id] = [];
                }
                gtfsData.shapes[point.shape_id].push({
                    lat: parseFloat(point.shape_pt_lat),
                    lon: parseFloat(point.shape_pt_lon),
                    seq: parseInt(point.shape_pt_sequence)
                });
            }
        });

        // Ordina shapes per sequenza
        Object.values(gtfsData.shapes).forEach(shape => 
            shape.sort((a, b) => a.seq - b.seq)
        );

        // Carica mappatura route_stops da JSON
        status.textContent = 'Caricamento mappatura fermate...';
        gtfsData.routeStops = {};
        for (const [routeName, stopIds] of Object.entries(routeStopsJson)) {
            gtfsData.routeStops[routeName] = new Set(stopIds);
        }

        status.className = 'status success';
        status.textContent = `✓ ${Object.keys(gtfsData.stops).length} fermate, ${availableRoutes.length} linee`;
        
        loadVehiclePositions();

    } catch (error) {
        status.className = 'status error';
        status.textContent = `Errore: ${error.message}`;
        console.error(error);
    }
}

// Carica trip updates (orari previsti)
async function loadTripUpdates() {
    try {
        const response = await fetch(TRP_URL);
        if (!response.ok) return;

        const root = protobuf.parse(GTFS_RT_PROTO).root;
        const FeedMessage = root.lookupType('transit_realtime.FeedMessage');
        const message = FeedMessage.decode(new Uint8Array(await response.arrayBuffer()));
        const object = FeedMessage.toObject(message, { longs: String });

        tripUpdates = {};
        object.entity.forEach(entity => {
            if (entity.tripUpdate && entity.tripUpdate.stopTimeUpdate) {
                entity.tripUpdate.stopTimeUpdate.forEach(stu => {
                    if (stu.stopId) {
                        if (!tripUpdates[stu.stopId]) {
                            tripUpdates[stu.stopId] = [];
                        }
                        tripUpdates[stu.stopId].push({
                            routeId: entity.tripUpdate.trip?.routeId,
                            arrivalTime: stu.arrival?.time ? 
                                new Date(parseInt(stu.arrival.time) * 1000) : null
                        });
                    }
                });
            }
        });

    } catch (error) {
        console.error('Errore trip updates:', error);
    }
}

// Carica posizioni veicoli
async function loadVehiclePositions() {
    const status = document.getElementById('statusRT');
    
    try {
        status.className = 'status loading';
        status.textContent = 'Aggiornamento...';

        await loadTripUpdates();

        const response = await fetch(VEH_URL);
        if (!response.ok) throw new Error('Errore download posizioni');

        const root = protobuf.parse(GTFS_RT_PROTO).root;
        const FeedMessage = root.lookupType('transit_realtime.FeedMessage');
        const message = FeedMessage.decode(new Uint8Array(await response.arrayBuffer()));
        const object = FeedMessage.toObject(message, { longs: String });

        allVehicles = object.entity
            .filter(e => e.vehicle && e.vehicle.position)
            .map(e => {
                const trip = gtfsData.trips[e.vehicle.trip?.tripId] || {};
                const route = gtfsData.routes[e.vehicle.trip?.routeId] || {};
                
                return {
                    id: e.id,
                    routeId: e.vehicle.trip?.routeId || 'N/D',
                    routeName: route.shortName || 'N/D',
                    headsign: trip.headsign || 'Destinazione N/D',
                    lat: e.vehicle.position.latitude,
                    lon: e.vehicle.position.longitude,
                    timestamp: e.vehicle.timestamp || object.header.timestamp,
                    shapeId: trip.shapeId
                };
            });

        status.className = 'status success';
        status.textContent = `✓ ${allVehicles.length} bus`;
        
        updateMap();

    } catch (error) {
        status.className = 'status error';
        status.textContent = `Errore: ${error.message}`;
        console.error(error);
    }
}

// Genera popup fermata
function getStopPopup(stop) {
    let html = `<div style="min-width:280px;">
        <strong>${stop.name}</strong><br>
        <span style="font-size:12px;color:#666;">Fermata: ${stop.code}</span>`;

    const updates = tripUpdates[stop.id] || [];
    const routeArrivals = {};

    updates.forEach(update => {
        if (update.arrivalTime && update.routeId) {
            const route = gtfsData.routes[update.routeId] || {};
            const routeName = route.shortName || update.routeId;
            const minutesUntil = Math.round((update.arrivalTime - new Date()) / 60000);
            
            if (minutesUntil >= 0 && minutesUntil < 60) {
                if (!routeArrivals[routeName] || routeArrivals[routeName] > minutesUntil) {
                    routeArrivals[routeName] = minutesUntil;
                }
            }
        }
    });

    if (Object.keys(routeArrivals).length) {
        html += '<div style="margin-top:10px;padding-top:10px;border-top:1px solid #ddd;">';
        html += '<strong>Arrivi:</strong><div style="margin-top:8px;">';
        
        Object.entries(routeArrivals)
            .sort((a, b) => a[1] - b[1])
            .forEach(([routeName, minutes]) => {
                html += `<button class="route-btn" onclick="searchFromPopup('${routeName}')">${routeName}</button> `;
                html += `<span>${minutes ? minutes + ' min' : 'ora'}</span><br>`;
            });
        
        html += '</div></div>';
    }

    return html + '</div>';
}

// Aggiorna mappa
function updateMap() {
    // Rimuovi marker esistenti
    busMarkers.forEach(m => map.removeLayer(m));
    stopMarkers.forEach(m => map.removeLayer(m));
    routePolylines.forEach(p => map.removeLayer(p));
    busMarkers = [];
    stopMarkers = [];
    routePolylines = [];

    const routeFilter = document.getElementById('routeFilter').value.trim().toUpperCase();
    const showBuses = document.getElementById('showBuses').checked;
    const showStops = document.getElementById('showStops').checked;
    const showRoutes = document.getElementById('showRoutes').checked;

    // Filtra veicoli
    let filteredVehicles = routeFilter ? 
        allVehicles.filter(v => v.routeName.toUpperCase() === routeFilter) : 
        allVehicles;

    // Mostra tracciati
    if (showRoutes && filteredVehicles.length) {
        const uniqueShapes = [...new Set(filteredVehicles.map(v => v.shapeId).filter(Boolean))];
        
        uniqueShapes.forEach(shapeId => {
            const shape = gtfsData.shapes[shapeId];
            if (shape && shape.length) {
                const polyline = L.polyline(
                    shape.map(p => [p.lat, p.lon]),
                    { color: '#666', weight: 3, opacity: 0.6 }
                ).addTo(map);
                routePolylines.push(polyline);
            }
        });
    }

    // Mostra fermate
    if (showStops) {
        let stopsToShow = [];

        if (viewportMode) {
            const bounds = map.getBounds();
            stopsToShow = Object.values(gtfsData.stops).filter(stop => 
                bounds.contains([stop.lat, stop.lon])
            );
        } else if (routeFilter && gtfsData.routeStops[routeFilter]) {
            const routeStopIds = gtfsData.routeStops[routeFilter];
            stopsToShow = Object.values(gtfsData.stops).filter(stop => 
                routeStopIds.has(stop.id)
            );
        } else if (!routeFilter) {
            stopsToShow = Object.values(gtfsData.stops);
        }

        stopsToShow.forEach(stop => {
            const icon = L.divIcon({
                className: '',
                html: `<div style="width:16px;height:20px;background:#FFD700;border:2px solid #333;
                       border-radius:3px 3px 0 0;box-shadow:0 2px 4px rgba(0,0,0,0.3);"></div>`,
                iconSize: [16, 20],
                iconAnchor: [8, 20]
            });

            const marker = L.marker([stop.lat, stop.lon], { icon })
                .addTo(map)
                .bindPopup(getStopPopup(stop));
            
            stopMarkers.push(marker);
        });
    }

    // Mostra bus
    if (showBuses) {
        filteredVehicles.forEach(vehicle => {
            const icon = L.divIcon({
                className: '',
                html: `<div style="width:24px;height:24px;background:#e2001a;border:3px solid white;
                       border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.3);display:flex;
                       align-items:center;justify-content:center;font-size:12px;">🚌</div>`,
                iconSize: [24, 24],
                iconAnchor: [12, 12]
            });

            const timestamp = new Date(parseInt(vehicle.timestamp) * 1000);
            const timeStr = timestamp.toLocaleTimeString('it-IT', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });

            const popup = `
                <div style="min-width:200px;">
                    <div style="font-size:16px;font-weight:bold;color:#e2001a;margin-bottom:8px;">
                        Linea ${vehicle.routeName}
                    </div>
                    <div>
                        <strong>Destinazione:</strong><br>
                        ${vehicle.headsign}
                    </div>
                    <div style="font-size:12px;color:#666;margin-top:8px;padding-top:8px;border-top:1px solid #ddd;">
                        Aggiornato: ${timeStr}
                    </div>
                </div>
            `;

            const marker = L.marker([vehicle.lat, vehicle.lon], { icon })
                .addTo(map)
                .bindPopup(popup);
            
            busMarkers.push(marker);
        });
    }

    // Aggiorna statistiche
    document.getElementById('stats').innerHTML = 
        `Bus: <strong>${showBuses ? filteredVehicles.length : 0}</strong> | ` +
        `Fermate: <strong>${stopMarkers.length}</strong>`;
}

// Auto-refresh ogni 30 secondi
setInterval(loadVehiclePositions, 30000);