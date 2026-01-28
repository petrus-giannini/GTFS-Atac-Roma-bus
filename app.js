// Variabili globali
let map, busMarkers = [], stopMarkers = [], routePolylines = [];
let allVehicles = [], availableRoutes = [], tripUpdates = {};
let gtfsData = { stops: {}, routes: {}, trips: {}, shapes: {}, routeStops: {}, routeDestinations: {} };
let userLocation = null, viewportMode = false;
let locationMarker = null;

// URL del proxy (sostituisci con il tuo URL di Render)
const PROXY_URL = 'https://gtfs-atac-proxy.onrender.com';
const VEH_URL = `${PROXY_URL}/api/vehicle-positions`;
const TRP_URL = `${PROXY_URL}/api/trip-updates`;

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

    // Pulsante localizzazione
    addLocationButton();

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

// Pulsante localizzazione
function addLocationButton() {
    const LocationControl = L.Control.extend({
        options: { position: 'topleft' },
        onAdd: function() {
            const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
            const button = L.DomUtil.create('a', 'leaflet-control-location', container);
            button.innerHTML = '📍';
            button.href = '#';
            button.title = 'La mia posizione';
            button.style.fontSize = '20px';
            button.style.width = '30px';
            button.style.height = '30px';
            button.style.lineHeight = '30px';
            button.style.textAlign = 'center';
            button.style.textDecoration = 'none';
            button.style.backgroundColor = 'white';
            
            L.DomEvent.on(button, 'click', function(e) {
                L.DomEvent.preventDefault(e);
                centerOnUserLocation();
            });
            
            return container;
        }
    });
    
    map.addControl(new LocationControl());
}

// Centra mappa sulla posizione utente
function centerOnUserLocation() {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            position => {
                const lat = position.coords.latitude;
                const lon = position.coords.longitude;
                userLocation = [lat, lon];
                
                map.setView(userLocation, 16);
                
                // Rimuovi marker precedente
                if (locationMarker) {
                    map.removeLayer(locationMarker);
                }
                
                // Aggiungi marker posizione
                const icon = L.divIcon({
                    className: '',
                    html: `<div style="width:20px;height:20px;background:#4A90E2;border:3px solid white;
                           border-radius:50%;box-shadow:0 0 0 3px rgba(74,144,226,0.3);"></div>`,
                    iconSize: [20, 20],
                    iconAnchor: [10, 10]
                });
                
                locationMarker = L.marker(userLocation, { icon })
                    .addTo(map)
                    .bindPopup('📍 La tua posizione');
            },
            error => {
                alert('Impossibile ottenere la posizione: ' + error.message);
            },
            { enableHighAccuracy: true }
        );
    } else {
        alert('Geolocalizzazione non supportata dal browser');
    }
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
    document.getElementById('showStops').checked = true;
    document.getElementById('showRoutes').checked = true;
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
                
                // Pre-calcola destinazioni per route (ottimizzazione)
                const route = gtfsData.routes[trip.route_id];
                if (route && route.shortName && trip.trip_headsign) {
                    if (!gtfsData.routeDestinations[route.shortName]) {
                        gtfsData.routeDestinations[route.shortName] = trip.trip_headsign;
                    }
                }
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
                            tripId: entity.tripUpdate.trip?.tripId,
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
    let html = `<div style="min-width:300px;">
        <strong>${stop.name}</strong><br>
        <span style="font-size:12px;color:#666;">Fermata: ${stop.code}</span>`;

    // Trova tutte le linee che passano per questa fermata
    const routesAtStop = new Set();
    for (const [routeName, stopIds] of Object.entries(gtfsData.routeStops)) {
        if (stopIds.has(stop.id)) {
            routesAtStop.add(routeName);
        }
    }

    if (routesAtStop.size === 0) {
        return html + '</div>';
    }

    // Ottieni gli orari di arrivo dai trip updates
    const updates = tripUpdates[stop.id] || [];
    const routeArrivals = {};
    const routeDestinations = {};

    // Cerca orari e destinazioni dai trip updates
    updates.forEach(update => {
        if (update.routeId) {
            const route = gtfsData.routes[update.routeId] || {};
            const routeName = route.shortName || update.routeId;
            
            // Orario di arrivo
            if (update.arrivalTime) {
                const minutesUntil = Math.round((update.arrivalTime - new Date()) / 60000);
                if (minutesUntil >= 0 && minutesUntil < 60) {
                    if (!routeArrivals[routeName] || routeArrivals[routeName] > minutesUntil) {
                        routeArrivals[routeName] = minutesUntil;
                    }
                }
            }
            
            // Destinazione dal trip
            if (update.tripId && !routeDestinations[routeName]) {
                const trip = gtfsData.trips[update.tripId];
                if (trip && trip.headsign) {
                    routeDestinations[routeName] = trip.headsign;
                }
            }
        }
    });

    // Aggiungi destinazioni pre-calcolate per linee senza trip updates
    routesAtStop.forEach(routeName => {
        if (!routeDestinations[routeName] && gtfsData.routeDestinations[routeName]) {
            routeDestinations[routeName] = gtfsData.routeDestinations[routeName];
        }
    });

    // Mostra tutte le linee
    html += '<div style="margin-top:10px;padding-top:10px;border-top:1px solid #ddd;">';
    html += '<strong>Linee:</strong><div style="margin-top:8px;">';
    
    const sortedRoutes = Array.from(routesAtStop).sort((a, b) => {
        const aHasTime = routeArrivals[a] !== undefined;
        const bHasTime = routeArrivals[b] !== undefined;
        if (aHasTime && !bHasTime) return -1;
        if (!aHasTime && bHasTime) return 1;
        if (aHasTime && bHasTime) return routeArrivals[a] - routeArrivals[b];
        return a.localeCompare(b, undefined, { numeric: true });
    });

    sortedRoutes.forEach(routeName => {
        const minutes = routeArrivals[routeName];
        const timeLabel = minutes !== undefined ? 
            (minutes === 0 ? 'ora' : minutes + ' min') : '';
        
        const destination = routeDestinations[routeName] || '';
        
        html += `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                <button class="route-btn" onclick="searchFromPopup('${routeName}')" 
                        style="padding:4px 8px;font-size:14px;margin:0;width:auto;min-width:50px;">${routeName}</button>
                <span style="font-size:13px;font-weight:bold;color:#e2001a;">${timeLabel}</span>
            </div>`;
        if (destination) {
            html += `<div style="font-size:11px;color:#666;margin-left:4px;margin-bottom:8px;">➜ ${destination}</div>`;
        }
    });
    
    html += '</div></div>';
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

    // Filtra veicoli - confronta con routeName non routeId
    let filteredVehicles = allVehicles;
    if (routeFilter) {
        filteredVehicles = allVehicles.filter(v => v.routeName.toUpperCase() === routeFilter);
        console.log(`Filtro linea "${routeFilter}": trovati ${filteredVehicles.length} bus`);
    }

    // Mostra tracciati
    if (showRoutes) {
        if (filteredVehicles.length > 0) {
            // Mostra tracciati delle linee filtrate
            const uniqueShapes = [...new Set(filteredVehicles.map(v => v.shapeId).filter(Boolean))];
            console.log(`Tracciati da mostrare: ${uniqueShapes.length}`, uniqueShapes);
            
            uniqueShapes.forEach(shapeId => {
                const shape = gtfsData.shapes[shapeId];
                if (shape && shape.length) {
                    const polyline = L.polyline(
                        shape.map(p => [p.lat, p.lon]),
                        { color: '#FF0000', weight: 4, opacity: 0.7 }
                    ).addTo(map);
                    routePolylines.push(polyline);
                }
            });
        } else if (!routeFilter) {
            // Se non c'è filtro e nessun bus, mostra tutti i tracciati disponibili
            // (opzionale, commentato per performance)
            // Object.values(gtfsData.shapes).forEach(shape => {...});
        }
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
            console.log(`Fermate linea "${routeFilter}": ${stopsToShow.length}`);
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
        `Fermate: <strong>${stopMarkers.length}</strong> | ` +
        `Tracciati: <strong>${routePolylines.length}</strong>`;
}

// Auto-refresh ogni 30 secondi
setInterval(loadVehiclePositions, 30000);