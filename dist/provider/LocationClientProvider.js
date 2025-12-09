import React, { createContext, useContext, useEffect, useState } from 'react';
import { GeoPlacesClient } from '@chaosity/location-client';
const LocationClientContext = createContext(undefined);
export function LocationClientProvider({ children, getConfig }) {
    const [config, setConfig] = useState(null);
    const [client, setClient] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    useEffect(() => {
        getConfig()
            .then((cfg) => {
            setConfig(cfg);
            setClient(new GeoPlacesClient(cfg));
            setLoading(false);
        })
            .catch((err) => {
            setError(err instanceof Error ? err.message : 'Failed to initialize client');
            setLoading(false);
        });
    }, []);
    return (React.createElement(LocationClientContext.Provider, { value: { config, client, loading, error } }, children));
}
export function useLocationClient() {
    const context = useContext(LocationClientContext);
    if (context === undefined) {
        throw new Error('useLocationClient must be used within LocationClientProvider');
    }
    return context;
}
