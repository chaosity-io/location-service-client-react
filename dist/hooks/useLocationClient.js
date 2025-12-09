import { useEffect, useState } from 'react';
import { GeoPlacesClient } from '@chaosity/location-client';
export function useLocationClient(options) {
    const [config, setConfig] = useState(null);
    const [client, setClient] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    useEffect(() => {
        options.getConfig()
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
    return { config, client, loading, error };
}
